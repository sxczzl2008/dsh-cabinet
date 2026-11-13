import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MemoryRouter } from './memory-router.mjs';
import { ModelCatalogService } from './model-catalog.mjs';
import { LlmBridge } from './llm-bridge.mjs';
import { SessionManager, NS, appendPluginRecord } from './session-manager.mjs';
import { CabinetOrchestrator, normalizeConfig, validateCabinetConfig } from './orchestrator.mjs';

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT_DIR = path.resolve(CURRENT_DIR, '..');

export const DEFAULT_PLAN = Object.freeze({
  schemaVersion: 2,
  blankDefaultInitialized: true,
  kind: 'plan',
  id: 'default-cabinet-plan',
  revision: 1,
  slotCount: 3,
  secretary: {
    id: 'secretary',
    model: null,
    label: '秘书席'
  },
  seats: [],
  staging: [],
  policies: {
    handoff: 'wait',
    humanApprovalRequired: false,
    memberPool: { scope: 'group', seatIds: [] }
  }
});

export class PlanStore {
  constructor(dataRoot) {
    this.file = path.join(path.resolve(dataRoot), 'saved-plan.json');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) {
      fs.writeFileSync(this.file, JSON.stringify({ revision: 1, plan: DEFAULT_PLAN }, null, 2) + '\n', 'utf8');
    } else {
      try {
        const existing = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (!existing?.plan?.blankDefaultInitialized) {
          fs.writeFileSync(this.file, JSON.stringify({ revision: 1, plan: DEFAULT_PLAN }, null, 2) + '\n', 'utf8');
        }
      } catch {
        fs.writeFileSync(this.file, JSON.stringify({ revision: 1, plan: DEFAULT_PLAN }, null, 2) + '\n', 'utf8');
      }
    }
  }

  get() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const plan = { ...normalizeConfig(data.plan ?? data, 'plan'), blankDefaultInitialized: true };
      const revision = Number.isSafeInteger(data.revision) ? data.revision : plan.revision;
      return { ok: true, revision, plan: { ...plan, revision } };
    } catch {
      return { ok: true, revision: 1, plan: { ...normalizeConfig(DEFAULT_PLAN, 'plan'), blankDefaultInitialized: true } };
    }
  }

  save(rawPlan, expectedRevision) {
    const check = validateCabinetConfig(rawPlan, 'plan');
    if (!check.ok) {
      throw Object.assign(new Error(check.errors[0]?.message || '配置不完整'), { code: 'INVALID_PLAN', errors: check.errors });
    }
    const current = this.get();
    const nextRevision = (Number.isSafeInteger(expectedRevision) ? expectedRevision : current.revision) + 1;
    const plan = { ...check.value, revision: nextRevision, blankDefaultInitialized: true };
    fs.writeFileSync(this.file, JSON.stringify({ revision: nextRevision, plan }, null, 2) + '\n', 'utf8');
    return { ok: true, revision: nextRevision, plan };
  }
}

function getSvc(ctx, key) {
  if (!ctx) return null;
  try {
    if (typeof ctx.get === 'function') {
      const v = ctx.get(key);
      if (v) return v;
    }
  } catch {}
  try {
    return ctx[key] ?? null;
  } catch {
    return null;
  }
}

export const name = 'dsh-cabinet';

export class CabinetV2 {
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.config = config;
    this.streams = new Set();
    this.sessionModes = new Map();

    const registerRoutes = (ws) => {
      if (!ws?.register) return;
      ws.register({
        kind: 'exact',
        path: '/cabinet-v2',
        handler: (req, res) => this.handleHttp(req, res).catch(err => {
          this.respond(res, err.status || 400, { ok: false, error: err.message, code: err.code || 'CABINET_ERROR', errors: err.errors });
        })
      });
      ws.register({
        kind: 'exact',
        path: '/cabinet-v2/events',
        handler: (req, res) => this.handleSse(req, res).catch(err => {
          this.respond(res, 400, { ok: false, error: err.message });
        })
      });
    };

    const directWs = getSvc(ctx, 'webServer');
    if (directWs?.register) {
      registerRoutes(directWs);
    } else if (typeof ctx?.inject === 'function') {
      try {
        ctx.inject(['webServer'], scoped => registerRoutes(getSvc(scoped, 'webServer') || getSvc(ctx, 'webServer')));
      } catch {}
    }

    try {
      ctx.cabinetV2 = this;
    } catch {}

    const baseHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    this.dataRoot = path.resolve(config.dataRoot || path.join(baseHome, 'cabinet-v2'));
    this.pluginRoot = path.resolve(config.pluginRoot || PLUGIN_ROOT_DIR);
    fs.mkdirSync(this.dataRoot, { recursive: true });

    this.plans = new PlanStore(this.dataRoot);
    this.memory = new MemoryRouter(this.dataRoot);
    this.catalog = new ModelCatalogService(ctx, config);
    this.catalog.subscribeEvents(() => this.broadcastAll());

    this.llmBridge = new LlmBridge(ctx, this.catalog, { customResponder: config.customResponder });
    this.sessionManager = new SessionManager(ctx, this.dataRoot);
    this.orchestrator = new CabinetOrchestrator({
      llmBridge: this.llmBridge,
      sessionManager: this.sessionManager,
      memoryRouter: this.memory,
      onStateChange: (sessionId) => this.publishStream(sessionId)
    });

    if (ctx.effect) {
      ctx.effect(() => () => {
        this.catalog.dispose();
        for (const s of this.streams) { try { s.res.end(); } catch {} }
        this.streams.clear();
      }, 'cabinet-v2 lifecycle');
    }
  }

  respond(res, status, payload) {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(payload));
  }

  isAuthenticated(req) {
    const auth = getSvc(this.ctx, 'connection')?.browserAuth;
    if (!auth) return true;
    const ws = getSvc(this.ctx, 'webServer');
    return auth.isAuthenticated(req, ws?.protocol === 'https:') === true;
  }

  async resolveParentAgent(sessionId) {
    const sc = getSvc(this.ctx, 'sessionController');
    if (!sessionId || !sc?.resolveAgent) return null;
    const res = await sc.resolveAgent(sessionId);
    return res?.agent ?? null;
  }

  getSessionState(agent, sessionId) {
    const id = sessionId || agent?.id || 'default-session';
    if (this.sessionModes.has(id)) return this.sessionModes.get(id);
    let mode = 'ordinary';
    let configVersion = 0;
    let config = null;
    const events = agent?.session?.snapshotEvents?.() ?? [];
    for (const ev of events) {
      if (ev.type === NS + 'transition' && ev.data) {
        configVersion = ev.data.configVersion ?? configVersion;
        if (ev.data.config?.blankDefaultInitialized) {
          mode = ev.data.mode || mode;
          config = { ...normalizeConfig(ev.data.config, 'task'), blankDefaultInitialized: true };
        }
      }
    }
    const state = { sessionId: id, mode, configVersion, config };
    this.sessionModes.set(id, state);
    return state;
  }

  async snapshot(sessionId) {
    const agent = await this.resolveParentAgent(sessionId);
    const state = this.getSessionState(agent, sessionId);
    const catalog = await this.catalog.getCatalog();
    const workspaceRoot = agent?.session?.header?.cwd || process.cwd();
    const run = state.config ? this.orchestrator.ensureRun(sessionId, state.config, workspaceRoot) : this.orchestrator.getRun(sessionId);

    return {
      sessionId,
      mode: state.mode,
      configVersion: state.configVersion,
      config: state.config,
      task: state.config,
      catalog,
      run: run ?? null,
      collaboration: run ? {
        runId: run.runId,
        taskId: run.taskId,
        configVersion: run.configVersion,
        stage: run.stage,
        stageLabel: run.stageLabel,
        round: run.round,
        stoppedAll: run.stoppedAll,
        awaitingHumanApproval: run.awaitingHumanApproval,
        userAcceptance: { status: run.userAcceptanceStatus },
        groups: run.groups,
        independents: run.independents,
        subteams: run.subteams,
        secretary: run.secretary,
        deliverables: run.deliverables,
        originals: (run.originals ?? []).map(o => ({
          sourceId: o.sourceId,
          groupKey: o.groupKey ?? null,
          actorId: o.actorId,
          actorLabel: o.actorLabel,
          role: o.role,
          roleBadge: o.roleBadge,
          providerId: o.providerId,
          modelId: o.modelId,
          text: o.text
        })),
        queue: run.queue
      } : null,
      sourceSeq: (agent?.session?.snapshotEvents?.().at(-1)?.seq ?? 0) + (run?.originals?.length ?? 0)
    };
  }

  async publishStream(sessionId) {
    for (const s of this.streams) {
      if (!sessionId || s.sessionId === sessionId) {
        try {
          const snap = await this.snapshot(s.sessionId);
          s.res.write(`data: ${JSON.stringify({ snapshot: snap })}\n\n`);
        } catch {}
      }
    }
  }

  broadcastAll() {
    for (const s of this.streams) void this.publishStream(s.sessionId);
  }

  async applyTask(sessionId, rawConfig, expectedVersion) {
    const check = validateCabinetConfig(rawConfig, 'task');
    if (!check.ok) {
      throw Object.assign(new Error(check.errors[0]?.message || '任务配置不完整'), { code: 'INVALID_TASK', errors: check.errors });
    }
    const agent = await this.resolveParentAgent(sessionId);
    const prev = this.getSessionState(agent, sessionId);
    const nextVersion = (Number.isSafeInteger(expectedVersion) ? expectedVersion : prev.configVersion) + 1;
    const config = { ...check.value, taskId: sessionId, configVersion: nextVersion, blankDefaultInitialized: true };

    const nextState = { sessionId, mode: 'cabinet', configVersion: nextVersion, config };
    this.sessionModes.set(sessionId, nextState);

    if (agent?.session) {
      try {
        appendPluginRecord(agent.session, NS + 'transition', {
          schemaVersion: 1,
          mode: 'cabinet',
          previousConfigVersion: prev.configVersion,
          configVersion: nextVersion,
          config,
          at: new Date().toISOString()
        });
      } catch {}
    }

    const workspaceRoot = agent?.session?.header?.cwd || process.cwd();
    this.orchestrator.ensureRun(sessionId, config, workspaceRoot);
    await this.publishStream(sessionId);
    return { ok: true, snapshot: await this.snapshot(sessionId) };
  }

  async selectOrdinary(agent, selection, doSelect) {
    const sessionId = agent?.id;
    const prev = this.getSessionState(agent, sessionId);
    if (prev.mode === 'cabinet') {
      const handoffPolicy = prev.config?.policies?.handoff || 'wait';
      if (handoffPolicy === 'cancel-at-boundary') {
        this.orchestrator.stopAll(sessionId);
      }
      const nextVersion = prev.configVersion + 1;
      this.sessionModes.set(sessionId, { sessionId, mode: 'ordinary', configVersion: nextVersion, config: prev.config });
      if (agent?.session) {
        try {
          appendPluginRecord(agent.session, NS + 'transition', {
            schemaVersion: 1,
            mode: 'ordinary',
            previousConfigVersion: prev.configVersion,
            configVersion: nextVersion,
            config: prev.config,
            at: new Date().toISOString()
          });
        } catch {}
      }
      await this.publishStream(sessionId);
    }
    if (typeof doSelect === 'function') doSelect();
  }

  async admit(parentAgent, message, request) {
    const sessionId = parentAgent?.id || 'default-session';
    const state = this.getSessionState(parentAgent, sessionId);
    if (state.mode !== 'cabinet' || !state.config) {
      const saved = this.plans.get().plan;
      await this.applyTask(sessionId, { ...saved, taskId: sessionId }, state.configVersion);
    }
    if (parentAgent?.session?.append) {
      try { parentAgent.session.append('user/message', message, { surfaceOp: 'append' }); } catch {}
    }
    const text = Array.isArray(message?.content)
      ? message.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim()
      : String(message?.content ?? '').trim();

    const workspaceRoot = parentAgent?.session?.header?.cwd || process.cwd();
    const currentState = this.getSessionState(parentAgent, sessionId);
    this.orchestrator.ensureRun(sessionId, currentState.config, workspaceRoot);

    void this.orchestrator.runTask(sessionId, parentAgent, text).catch(() => {});
    await this.publishStream(sessionId);
  }

  async groupCommand(sessionId, command = {}) {
    const parentAgent = await this.resolveParentAgent(sessionId);
    const state = this.getSessionState(parentAgent, sessionId);
    const workspaceRoot = parentAgent?.session?.header?.cwd || process.cwd();
    const run = state.config ? this.orchestrator.ensureRun(sessionId, state.config, workspaceRoot) : this.orchestrator.getRun(sessionId);
    if (!run) throw new Error('请先应用本任务配置');

    const action = command.action;
    let result = { ok: true, action };

    if (action === 'stop-group' || (action === 'stop' && command.groupKey)) {
      this.orchestrator.stopGroup(sessionId, command.groupKey);
    } else if (action === 'resume-group' || (action === 'resume' && command.groupKey)) {
      await this.orchestrator.resumeGroup(sessionId, command.groupKey, parentAgent);
    } else if (action === 'stop-all' || action === 'stop') {
      this.orchestrator.stopAll(sessionId);
    } else if (action === 'resume-all' || action === 'resume') {
      await this.orchestrator.resumeAll(sessionId, parentAgent);
    } else if (action === 'queue-instruction') {
      const queued = this.orchestrator.enqueueInstruction(sessionId, {
        groupKey: command.groupKey || null,
        selector: command.selector || 'current',
        participantId: command.participantId || null,
        text: command.text || ''
      });
      result = { ok: true, instruction: queued };
    } else if (action === 'approve-design') {
      run.awaitingHumanApproval = false;
      if (run.designArtifact) run.designArtifact.approved = true;
      void this.orchestrator.runTask(sessionId, parentAgent, '认可此版').catch(() => {});
    } else if (action === 'reject-design') {
      run.awaitingHumanApproval = false;
      if (run.designArtifact) run.designArtifact.approved = false;
      run.round += 1;
      void this.orchestrator.runTask(sessionId, parentAgent, command.text || '退回修改设计方案').catch(() => {});
    } else if (action === 'create-subteam') {
      const sub = await this.orchestrator.createSubteam(sessionId, command);
      result = { ok: true, subteam: sub };
    } else if (action === 'start' || action === 'run') {
      void this.orchestrator.runTask(sessionId, parentAgent, command.text || run.config.goal || '开始执行任务').catch(() => {});
    }

    await this.publishStream(sessionId);
    return { ok: true, result, snapshot: await this.snapshot(sessionId) };
  }

  async handleHttp(req, res) {
    if (!this.isAuthenticated(req)) {
      this.respond(res, 401, { ok: false, error: '当前浏览器会话未认证' });
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const action = url.searchParams.get('action');

    if (req.method === 'GET') {
      if (action === 'getPlan') {
        const planData = this.plans.get();
        const catalog = await this.catalog.getCatalog();
        const runtimeInfo = {
          pluginPath: this.pluginRoot,
          planFilePath: this.plans.file,
          dataRoot: this.dataRoot
        };
        this.respond(res, 200, { ...planData, catalog, runtimeInfo });
        return;
      }
      if (action === 'catalog') {
        const force = url.searchParams.get('refresh') === '1';
        this.respond(res, 200, { ok: true, catalog: await this.catalog.getCatalog({ forceRefresh: force }) });
        return;
      }
      if (action === 'snapshot') {
        const sessionId = url.searchParams.get('sessionId') || 'default-session';
        this.respond(res, 200, { ok: true, snapshot: await this.snapshot(sessionId) });
        return;
      }
      if (action === 'readGroupConversation') {
        const sessionId = url.searchParams.get('sessionId') || 'default-session';
        const groupId = url.searchParams.get('groupId') || '';
        const thread = this.sessionManager.readGroupThread(sessionId, groupId);
        this.respond(res, 200, { ok: true, conversation: thread });
        return;
      }
      if (action === 'readGroupOriginal') {
        const sourceId = url.searchParams.get('sourceId') || '';
        const source = this.sessionManager.readOriginal(sourceId);
        this.respond(res, 200, { ok: true, source });
        return;
      }
      this.respond(res, 404, { ok: false, error: '未知查询动作' });
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1048576) throw new Error('请求内容超过上限');
      }
      const input = JSON.parse(body || '{}');
      if (input.action === 'savePlan') {
        this.respond(res, 200, this.plans.save(input.config, input.expectedVersion));
        return;
      }
      if (input.action === 'applyTask') {
        this.respond(res, 200, await this.applyTask(input.sessionId, input.config, input.expectedVersion));
        return;
      }
      if (input.action === 'groupCommand') {
        this.respond(res, 200, await this.groupCommand(input.sessionId, input.command));
        return;
      }
      this.respond(res, 400, { ok: false, error: `未知操作：${input.action}` });
    }
  }

  async handleSse(req, res) {
    if (!this.isAuthenticated(req)) {
      this.respond(res, 401, { ok: false, error: '未认证' });
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const sessionId = url.searchParams.get('sessionId') || 'default-session';
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive'
    });
    const entry = { sessionId, res };
    this.streams.add(entry);
    req.on('close', () => this.streams.delete(entry));
    await this.publishStream(sessionId);
  }
}

export function apply(ctx, config = {}) {
  try {
    new CabinetV2(ctx, config);
  } catch {
    /* apply() must never throw */
  }
}

export default { name, apply };


