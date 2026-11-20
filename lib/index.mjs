import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MemoryRouter } from './memory-router.mjs';
import { ModelCatalogService } from './model-catalog.mjs';
import { TeamRuntime } from './team-runtime.mjs';
import { CabinetOrchestrator, normalizeConfig, validateCabinetConfig, PRESET_MODES, buildPresetConfig } from './orchestrator.mjs';

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT_DIR = path.resolve(CURRENT_DIR, '..');
export const NS = 'plugin:cabinet-v2/';
export { PRESET_MODES, buildPresetConfig };

export const DEFAULT_PLAN = Object.freeze({
  schemaVersion: 3,
  blankDefaultInitialized: true,
  kind: 'plan',
  id: 'default-cabinet-plan',
  revision: 1,
  presetMode: 'free',
  slotCount: 3,
  secretary: { id: 'secretary', model: null, label: '秘书席' },
  seats: [],
  staging: [],
  policies: {
    handoff: 'wait',
    humanApprovalRequired: false,
    constructionExecutionMode: 'parallel',
    memberPool: { scope: 'group', seatIds: [] }
  }
});

export class PlanStore {
  constructor(dataRoot) {
    this.file = path.join(path.resolve(dataRoot), 'saved-plan.json');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) {
      fs.writeFileSync(this.file, JSON.stringify({ revision: 1, plan: DEFAULT_PLAN }, null, 2) + '\n', 'utf8');
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
    return { ok: true, revision: nextRevision, plan, warnings: check.warnings || [] };
  }
}

export class HistoryStore {
  constructor(dataRoot) {
    this.file = path.join(path.resolve(dataRoot), 'history-index.json');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
  }

  read() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
        deletedKeys: Array.isArray(raw.deletedKeys) ? raw.deletedKeys : []
      };
    } catch {
      return { tasks: [], deletedKeys: [] };
    }
  }

  write(data) {
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }

  isDeleted(sessionId, taskId) {
    const key = `${sessionId}::${taskId}`;
    return this.read().deletedKeys.includes(key);
  }

  upsertTasks(sessionTasks = []) {
    if (!sessionTasks.length) return;
    const data = this.read();
    const deleted = new Set(data.deletedKeys);
    const byKey = new Map(data.tasks.map(t => [`${t.parentSessionId}::${t.taskId}`, t]));
    let changed = false;
    for (const task of sessionTasks) {
      if (!task?.parentSessionId || !task?.taskId) continue;
      const key = `${task.parentSessionId}::${task.taskId}`;
      if (deleted.has(key)) continue;
      const prev = byKey.get(key);
      const nextJson = JSON.stringify(task);
      if (!prev || JSON.stringify(prev) !== nextJson) {
        byKey.set(key, task);
        changed = true;
      }
    }
    if (changed) {
      data.tasks = [...byKey.values()]
        .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))
        .slice(0, 120);
      this.write(data);
    }
  }

  listCompleted(sessionId = null) {
    const data = this.read();
    const deleted = new Set(data.deletedKeys);
    return data.tasks.filter(t =>
      t.completed
      && !deleted.has(`${t.parentSessionId}::${t.taskId}`)
      && (!sessionId || t.parentSessionId === sessionId)
    );
  }

  deleteTask(sessionId, taskId) {
    const data = this.read();
    const key = `${sessionId}::${taskId}`;
    const before = data.tasks.length;
    data.tasks = data.tasks.filter(t => `${t.parentSessionId}::${t.taskId}` !== key);
    if (!data.deletedKeys.includes(key)) data.deletedKeys.push(key);
    this.write(data);
    return { deletedFiles: before - data.tasks.length, deletedSessions: [], blocked: [] };
  }

  clearDeletedCaches() {
    const data = this.read();
    const count = data.deletedKeys.length;
    data.deletedKeys = [];
    this.write(data);
    return count;
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
  try { return ctx[key] ?? null; } catch { return null; }
}

async function appendRecord(session, type, data) {
  const api = await import('@deepseek-ai/dsh-session');
  return api.appendPluginRecord(session, type, JSON.parse(JSON.stringify(data)));
}

export const name = 'dsh-cabinet';
export const inject = ['sessionController', 'agents', 'sessions', 'subagents', 'systemPrompt'];

export class CabinetV2 {
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.config = config;
    this.shuttingDown = false;
    this.streams = new Set();
    this.sessionModes = new Map();
    this.agentBindings = new Map();

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
    if (directWs?.register) registerRoutes(directWs);
    else if (typeof ctx?.inject === 'function') {
      try { ctx.inject(['webServer'], scoped => registerRoutes(getSvc(scoped, 'webServer') || getSvc(ctx, 'webServer'))); } catch {}
    }

    ctx.provide('cabinetV2', this);

    const baseHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    this.dataRoot = path.resolve(config.dataRoot || path.join(baseHome, 'cabinet-v2'));
    this.pluginRoot = path.resolve(config.pluginRoot || PLUGIN_ROOT_DIR);
    fs.mkdirSync(this.dataRoot, { recursive: true });

    this.plans = new PlanStore(this.dataRoot);
    this.historyStore = new HistoryStore(this.dataRoot);
    this.memory = new MemoryRouter(this.dataRoot);
    this.catalog = new ModelCatalogService(ctx, config);
    this.catalog.subscribeEvents(() => this.broadcastAll());
    this.runtime = new TeamRuntime(ctx, this.memory, (agent) => {
      if (agent?.session?.header?.origin === 'subagent') return false;
      const state = this.getSessionState(agent, agent.id);
      if (state.mode !== 'ordinary') return false;
      const events = agent?.session?.snapshotEvents?.() ?? [];
      return events.some(ev => ev.type === NS + 'transition');
    });
    this.orchestrator = new CabinetOrchestrator({
      teamRuntime: this.runtime,
      onStateChange: (sessionId) => this.publishStream(sessionId),
      onCompleted: (sessionId) => this.exitCabinetMode(sessionId, 'completed', { keepRun: true })
    });

    ctx.on('agent/created', ({ agent }) => {
      if (this.getSessionState(agent, agent.id).mode === 'cabinet') this.attachAgent(agent);
    }, { global: true });
    ctx.on('agent/disposed', ({ agent }) => this.detachAgent(agent), { global: true });
    ctx.on('agent/pre-step', async ({ agent, messages, step }, next) => {
      return this.handlePreStep(agent, messages, step, next);
    }, { prepend: true });

    if (ctx.effect) {
      ctx.effect(() => () => {
        this.shuttingDown = true;
        for (const { agent } of [...this.agentBindings.values()]) this.detachAgent(agent);
        this.runtime.dispose();
        this.catalog.dispose();
        for (const s of [...this.streams]) {
          this.streams.delete(s);
          try { s.res.end(); } catch {}
        }
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

  attachAgent(agent) {
    const current = this.agentBindings.get(agent.id);
    if (current?.agent === agent) return;
    if (current) this.detachAgent(current.agent);

    const model = agent.model;
    if (!model || typeof model.select !== 'function') return;
    const originalSelect = model.select;
    const select = selection => this.selectOrdinary(agent, selection, () => originalSelect.call(model, selection));
    model.select = select;
    this.agentBindings.set(agent.id, { agent, model, originalSelect, select });
  }

  detachAgent(agent) {
    const binding = this.agentBindings.get(agent.id);
    if (!binding || binding.agent !== agent) return;
    if (binding.model.select === binding.select) binding.model.select = binding.originalSelect;
    this.agentBindings.delete(agent.id);
  }

  async handlePreStep(agent, messages = [], step = 1, next) {
    // 放行所有内阁子智能体及其他子智能体，绝不干预它们的原生执行循环
    if (!agent || agent.session?.header?.origin === 'subagent' || this.runtime.isOwnedChild(agent.id)) {
      return next();
    }

    const list = Array.isArray(messages) ? messages : [];
    const isOwnedSettlement = (m) =>
      m?.source?.kind === 'subagent-settled' && this.runtime.isOwnedChild(m?.source?.senderSessionId);

    const state = this.getSessionState(agent, agent.id);
    if (state.mode === 'cabinet' && state.config) {
      const userMsg = list.find(m => m?.content?.length > 0 && m?.source?.kind === 'user' && 'rpcId' in m.source);
      if (userMsg) {
        await this.admit(agent, userMsg).catch(error => {
          const run = this.orchestrator.getRun(agent.id);
          if (run) {
            run.error = error.message;
            run.stageLabel = '指令未接收：' + error.message;
            this.orchestrator.emit(agent.id);
          }
        });
      }
      // 交回空消息列表，由官方 AgentLoop 自己合法闭环 turn/start -> turn/end (completed)，
      // 不进入 step/start、不写任何 surface 节点、不调用主会话单模型 LLM
      return { kind: 'enter', messages: [] };
    }

    // 普通单模型模式下，过滤掉本内阁子智能体迟到的 subagent-settled 通知，防止误唤醒主会话 lead
    const hasOwnedNotice = list.some(isOwnedSettlement);
    if (!hasOwnedNotice) return next();

    const remaining = list.filter(m => !isOwnedSettlement(m));
    if (remaining.length === 0 && step === 1) {
      return { kind: 'enter', messages: [] };
    }
    const decision = await next();
    if (decision?.kind === 'enter' && Array.isArray(decision.messages)) {
      return { ...decision, messages: decision.messages.filter(m => !isOwnedSettlement(m)) };
    }
    return decision;
  }

  async exitCabinetMode(sessionId, reason = 'manual', { keepRun = false } = {}) {
    const agent = await this.resolveParentAgent(sessionId);
    const prev = this.getSessionState(agent, sessionId);
    if (!keepRun) this.orchestrator.stopAll(sessionId);
    if (agent) {
      await this.runtime.setTeamEnabled(agent, false);
      if (agent.session && prev.mode === 'cabinet') {
        await appendRecord(agent.session, NS + 'transition', {
          schemaVersion: 1, mode: 'ordinary', configVersion: prev.configVersion + 1,
          config: null, associationDetached: true, reason, at: new Date().toISOString()
        });
        const sessions = getSvc(this.ctx, 'sessions');
        if (typeof sessions?.flush === 'function') await sessions.flush(agent.session);
      }
    }
    const nextVersion = prev.mode === 'cabinet' ? prev.configVersion + 1 : prev.configVersion;
    this.sessionModes.set(sessionId, { sessionId, mode: 'ordinary', configVersion: nextVersion, config: null });
    if (!keepRun) this.orchestrator.runs.delete(sessionId);
    await this.publishStream(sessionId);
    return { ok: true, snapshot: await this.snapshot(sessionId) };
  }

  async selectOrdinary(agent, selection, fallback) {
    const state = this.getSessionState(agent, agent.id);
    if (state.mode === 'cabinet' && this.orchestrator.taskControllers.has(agent.id)) {
      throw new Error('内阁任务进行中，请先停止全部工作或点击「退出内阁」');
    }
    if (state.mode === 'cabinet') {
      await this.exitCabinetMode(agent.id, 'switch-ordinary', { keepRun: true });
    }
    return fallback?.(selection);
  }

  getSessionState(agent, sessionId) {
    const id = sessionId || agent?.id || 'default-session';
    if (this.sessionModes.has(id)) return this.sessionModes.get(id);
    let mode = 'ordinary', configVersion = 0, config = null;
    const events = agent?.session?.snapshotEvents?.() ?? [];
    for (const ev of events) {
      if (ev.type === NS + 'transition' && ev.data) {
        configVersion = ev.data.configVersion ?? configVersion;
        if (ev.data.associationDetached === true || ev.data.config === null) {
          mode = 'ordinary'; config = null;
        } else if (ev.data.config) {
          mode = ev.data.mode || 'cabinet';
          config = normalizeConfig(ev.data.config, 'task');
        }
      }
    }
    const state = { sessionId: id, mode, configVersion, config };
    this.sessionModes.set(id, state);
    return state;
  }

  async applyTask(sessionId, rawConfig, expectedVersion) {
    const check = validateCabinetConfig(rawConfig, 'task');
    if (!check.ok) {
      throw Object.assign(new Error(check.errors[0]?.message || '任务配置不完整'), { code: 'INVALID_TASK', errors: check.errors });
    }
    const agent = await this.resolveParentAgent(sessionId);
    const prev = this.getSessionState(agent, sessionId);
    if (this.orchestrator.taskControllers.has(sessionId)) throw new Error('当前任务正在运行，请停止后再重新应用');
    const nextVersion = (Number.isSafeInteger(expectedVersion) ? expectedVersion : prev.configVersion) + 1;
    const config = { ...check.value, taskId: 'task-' + crypto.randomUUID(), configVersion: nextVersion };

    const nextState = { sessionId, mode: 'cabinet', configVersion: nextVersion, config };
    this.sessionModes.set(sessionId, nextState);
    if (agent) {
      this.attachAgent(agent);
      if (agent.session) {
        await appendRecord(agent.session, NS + 'transition', {
          schemaVersion: 1, mode: 'cabinet', previousConfigVersion: prev.configVersion,
          configVersion: nextVersion, config, at: new Date().toISOString()
        });
        const sessions = getSvc(this.ctx, 'sessions');
        if (typeof sessions?.flush === 'function') await sessions.flush(agent.session);
      }
    }
    this.orchestrator.ensureRun(sessionId, config);
    await this.publishStream(sessionId);
    return { ok: true, warnings: check.warnings || [], snapshot: await this.snapshot(sessionId) };
  }

  async detachConfiguration(sessionId) {
    return this.exitCabinetMode(sessionId, 'manual', { keepRun: false });
  }

  async admit(parentAgent, message) {
    const sessionId = parentAgent.id;
    const text = Array.isArray(message?.content)
      ? message.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
      : String(message?.content ?? '');
    if (!text.trim()) return;

    const state = this.getSessionState(parentAgent, sessionId);
    if (state.mode !== 'cabinet' || !state.config) return;
    const run = this.orchestrator.ensureRun(sessionId, state.config);

    if (this.orchestrator.taskControllers.has(sessionId)) {
      await this.orchestrator.enqueueInstruction(sessionId, { selector: 'next', text });
      await this.publishStream(sessionId);
      return;
    }

    if (parentAgent.session) {
      await appendRecord(parentAgent.session, NS + 'user-prompt', {
        id: message?.id || 'cab-user-' + crypto.randomUUID(),
        source: message?.source?.kind === 'user'
          ? { kind: 'user', ...(typeof message.source.rpcId === 'string' ? { rpcId: message.source.rpcId } : {}) }
          : { kind: 'user' },
        text: text.trim(),
        at: new Date().toISOString()
      });
      const sessions = getSvc(this.ctx, 'sessions');
      if (typeof sessions?.flush === 'function') await sessions.flush(parentAgent.session);
    }
    void this.orchestrator.runTask(sessionId, parentAgent, text.trim());
    await this.publishStream(sessionId);
  }

  async groupCommand(sessionId, command = {}) {
    const action = command.action;
    if (action === 'exit-cabinet') {
      return await this.exitCabinetMode(sessionId, 'manual', { keepRun: false });
    }
    const parentAgent = await this.resolveParentAgent(sessionId);
    const state = this.getSessionState(parentAgent, sessionId);
    const run = state.config ? this.orchestrator.ensureRun(sessionId, state.config) : this.orchestrator.getRun(sessionId);
    if (!run) throw new Error('请先应用本任务配置');

    let result = { ok: true, action };
    if (action === 'stop-group' || (action === 'stop' && command.groupKey)) {
      this.orchestrator.stopGroup(sessionId, command.groupKey);
    } else if (action === 'stop-all' || action === 'stop') {
      this.orchestrator.stopAll(sessionId);
    } else if (action === 'resume-group' && command.groupKey) {
      this.orchestrator.resumeGroup(sessionId, command.groupKey);
      if (!this.orchestrator.taskControllers.has(sessionId) && (run.originalUserMessage || run.taskGoalText)) {
        void this.orchestrator.runTask(sessionId, parentAgent, '');
      }
    } else if (action === 'resume-all') {
      this.orchestrator.resumeAll(sessionId);
      if (!this.orchestrator.taskControllers.has(sessionId) && (run.originalUserMessage || run.taskGoalText)) {
        void this.orchestrator.runTask(sessionId, parentAgent, '');
      }
    } else if (action === 'update-and-resume') {
      if (this.orchestrator.taskControllers.has(sessionId)) {
        throw new Error('任务仍在运行中，请先停止全部工作后再调整');
      }
      const { normalized } = this.orchestrator.updateConfig(sessionId, command.config || {});
      this.sessionModes.set(sessionId, {
        sessionId,
        mode: 'cabinet',
        configVersion: normalized.configVersion,
        config: normalized
      });
      if (parentAgent?.session) {
        await appendRecord(parentAgent.session, NS + 'transition', {
          schemaVersion: 1,
          mode: 'cabinet',
          previousConfigVersion: state.configVersion,
          configVersion: normalized.configVersion,
          config: normalized,
          at: new Date().toISOString()
        });
        const sessions = getSvc(this.ctx, 'sessions');
        if (typeof sessions?.flush === 'function') await sessions.flush(parentAgent.session);
      }
      if (run.originalUserMessage || run.taskGoalText) {
        void this.orchestrator.runTask(sessionId, parentAgent, '');
      }
    } else if (action === 'end-task') {
      this.orchestrator.endTask(sessionId);
      return await this.exitCabinetMode(sessionId, 'ended', { keepRun: false });
    } else if (action === 'resolve-circuit-breaker') {
      run.circuitBreaker = null;
      run.error = null;
      run.stoppedAll = false;
      run.outerCycleCount = 1;
      run.constructionReworkCount = 0;
      if (run.designArtifact && command.resetToDesign) {
        run.designArtifact.approved = false;
      }
      if (command.text && String(command.text).trim()) {
        await this.orchestrator.enqueueInstruction(sessionId, { selector: 'next', text: String(command.text).trim() });
      }
      if (!this.orchestrator.taskControllers.has(sessionId)) {
        void this.orchestrator.runTask(sessionId, parentAgent, run.originalUserMessage || run.taskGoalText || '');
      }
    } else if (action === 'queue-instruction') {
      result = { ok: true, instruction: await this.orchestrator.enqueueInstruction(sessionId, command) };
    } else if (action === 'approve-design') {
      if (!run.awaitingHumanApproval) throw new Error('当前没有待确认的设计');
      void this.orchestrator.runTask(sessionId, parentAgent, '认可此版');
    } else if (action === 'reject-design') {
      if (!run.awaitingHumanApproval) throw new Error('当前没有待确认的设计');
      run.awaitingHumanApproval = false;
      run.humanApproved = false;
      if (run.designArtifact) run.designArtifact.approved = false;
      for (const group of run.groups.filter(g => g.role === 'design')) {
        group.stopped = false;
        await this.orchestrator.enqueueInstruction(sessionId, { groupKey: group.key, text: command.text || '退回修改设计方案' });
      }
      void this.orchestrator.runTask(sessionId, parentAgent, run.originalUserMessage || run.taskGoalText || '');
    }

    await this.publishStream(sessionId);
    return { ok: true, result, snapshot: await this.snapshot(sessionId) };
  }

  buildSessionTaskHistory(sessionId, agent) {
    const events = agent?.session?.snapshotEvents?.() ?? [];
    const liveRun = this.orchestrator.getRun(sessionId);
    const isRunning = this.orchestrator.taskControllers.has(sessionId);
    const records = [];
    let current = null;

    const createFromTransition = (ev) => {
      const cfg = normalizeConfig(ev.data.config, 'task');
      const checked = validateCabinetConfig(cfg, 'task');
      const groups = checked.groups.map(g => ({
        groupKey: g.key,
        role: g.role,
        label: g.label,
        nativeSessionId: null,
        members: []
      }));
      return {
        parentSessionId: sessionId,
        taskId: cfg.taskId || `task-seq-${ev.seq}`,
        configVersion: ev.data.configVersion ?? cfg.configVersion ?? 1,
        presetMode: cfg.presetMode || 'free',
        goal: cfg.goal || '',
        promptText: '',
        startedAt: ev.data.at || (ev.time ? new Date(ev.time).toISOString() : new Date().toISOString()),
        endedAt: null,
        completed: false,
        statusLabel: '待命',
        groups,
        verdicts: [],
        secretary: null,
        subagents: [],
        reports: []
      };
    };

    const assignSubagent = (rec, sub) => {
      if (!rec || !sub.childId || rec.subagents.some(s => s.childId === sub.childId)) return;
      rec.subagents.push(sub);
      const lname = String(sub.name || '').toLowerCase();
      const label = String(sub.label || '');
      if (lname === 'cabinet-secretary' || label.startsWith('秘书')) {
        rec.secretary = sub;
        return;
      }
      if (lname.includes('-ver') || lname.includes('-v-')) {
        rec.verdicts.push({ ...sub, label: `${label || sub.name}（裁决 ${rec.verdicts.length + 1}）` });
        return;
      }
      let targetGroup = rec.groups.find(g => label.startsWith(`${g.label} ·`) || lname.startsWith(`${g.role}-`));
      if (!targetGroup) {
        const inferredRole = lname.startsWith('design-') ? 'design'
          : lname.startsWith('construction-') ? 'construction'
          : lname.startsWith('review-') ? 'review' : 'other';
        const roleName = inferredRole === 'design' ? '设计组'
          : inferredRole === 'construction' ? '施工组'
          : inferredRole === 'review' ? '审验组' : '独立席';
        targetGroup = { groupKey: `${inferredRole}::auto`, role: inferredRole, label: roleName, nativeSessionId: null, members: [] };
        rec.groups.push(targetGroup);
      }
      targetGroup.members.push(sub);
      if (!targetGroup.nativeSessionId) targetGroup.nativeSessionId = sub.childId;
    };

    for (const ev of events) {
      if (ev.type === NS + 'transition' && ev.data) {
        if (ev.data.mode === 'cabinet' && ev.data.config) {
          if (current && !current.completed) {
            current.completed = true;
            current.endedAt = ev.data.at || current.endedAt;
            if (current.statusLabel === '进行中' || current.statusLabel === '待命') current.statusLabel = '已结束';
          }
          current = createFromTransition(ev);
          records.push(current);
        } else if (ev.data.associationDetached === true || ev.data.mode === 'ordinary') {
          if (current) {
            current.completed = true;
            current.endedAt = ev.data.at || (ev.time ? new Date(ev.time).toISOString() : null);
            if (ev.data.reason === 'completed') current.statusLabel = '已完成';
            else if (ev.data.reason === 'ended') current.statusLabel = '已结束';
            else if (current.statusLabel === '进行中' || current.statusLabel === '待命') {
              current.statusLabel = current.reports.some(r => r.phase === 'cabinet-blocked') ? '三次熔断 · 暂停' : '已退出内阁';
            }
          }
        }
      } else if (ev.type === NS + 'user-prompt' && ev.data?.text && current) {
        const clean = String(ev.data.text).trim();
        if (!current.promptText) current.promptText = clean;
        if (!current.goal) current.goal = clean.length > 72 ? `${clean.slice(0, 72)}…` : clean;
        if (!current.completed) current.statusLabel = '进行中';
      } else if (ev.type === 'subagent/catalog' && ev.data?.childId) {
        if (!current) {
          current = {
            parentSessionId: sessionId,
            taskId: `task-orphan-${ev.seq}`,
            configVersion: 1,
            presetMode: 'free',
            goal: '历史内阁任务',
            promptText: '',
            startedAt: ev.time ? new Date(ev.time).toISOString() : new Date().toISOString(),
            endedAt: null,
            completed: true,
            statusLabel: '历史归档',
            groups: [],
            verdicts: [],
            secretary: null,
            subagents: [],
            reports: []
          };
          records.push(current);
        }
        assignSubagent(current, {
          childId: ev.data.childId,
          name: ev.data.name || '',
          label: ev.data.label || ev.data.name || ev.data.childId.slice(0, 8),
          createdAt: ev.data.childCreatedAt ? new Date(ev.data.childCreatedAt).toISOString() : (ev.time ? new Date(ev.time).toISOString() : null)
        });
      } else if (ev.type === NS + 'presentation' && ev.data?.text && current) {
        current.reports.push({
          id: ev.data.messageId || `pres-${ev.seq}`,
          title: ev.data.title || ev.data.groupLabel || '内阁汇报',
          phase: ev.data.phase || ev.data.role || '',
          text: String(ev.data.text),
          at: ev.data.at || (ev.time ? new Date(ev.time).toISOString() : null)
        });
        if (ev.data.phase === 'cabinet-blocked') current.statusLabel = '三次熔断 · 暂停';
        else if (ev.data.phase === 'secretary-final' || ev.data.phase === 'final-delivery') current.statusLabel = '已完成';
      }
    }

    for (const rec of records) {
      if (!rec.goal) rec.goal = '未命名内阁任务';
      if (liveRun && liveRun.taskId === rec.taskId) {
        if (isRunning) {
          rec.completed = false;
          rec.statusLabel = liveRun.stageLabel || '进行中';
        }
        if (liveRun.secretary?.reports?.length) {
          for (const sr of liveRun.secretary.reports) {
            if (!rec.reports.some(r => r.id === sr.id)) {
              rec.reports.push({ id: sr.id, title: sr.kind === 'final' ? '秘书最终总结' : '秘书阶段汇报', phase: sr.kind, text: sr.text, at: sr.at });
            }
          }
        }
      } else if (!rec.completed && !isRunning) {
        if (rec.reports.some(r => r.phase === 'cabinet-blocked')) rec.statusLabel = '三次熔断 · 暂停';
        else if (rec.subagents.length) rec.statusLabel = '已暂停 / 历史归档';
      }
      rec.groups = rec.groups.filter(g => g.members.length > 0 || g.nativeSessionId);
    }

    const visible = records
      .filter(r => !this.historyStore.isDeleted(sessionId, r.taskId) && (r.promptText || r.subagents.length > 0 || r.reports.length > 0))
      .reverse();

    if (visible.length) {
      this.historyStore.upsertTasks(visible);
    }
    return visible;
  }

  async snapshot(sessionId) {
    const agent = await this.resolveParentAgent(sessionId);
    const state = this.getSessionState(agent, sessionId);
    if (agent && state.mode === 'cabinet') this.attachAgent(agent);
    const catalog = await this.catalog.getCatalog();
    const run = state.config ? this.orchestrator.ensureRun(sessionId, state.config) : this.orchestrator.getRun(sessionId);
    const history = this.buildSessionTaskHistory(sessionId, agent);

    return {
      sessionId,
      mode: state.mode,
      configVersion: state.configVersion,
      config: state.config,
      task: state.config,
      associatedTaskId: state.config?.taskId ?? null,
      canDetachConfiguration: Boolean(state.config) && !this.orchestrator.taskControllers.has(sessionId),
      catalog,
      history,
      run: run ?? null,
      collaboration: run ? {
        runId: run.runId,
        taskId: run.taskId,
        configVersion: run.configVersion,
        presetMode: run.presetMode || run.config?.presetMode || 'free',
        lifecycle: this.orchestrator.taskControllers.has(sessionId) ? 'running' : (run.lifecycle || 'idle'),
        isRunning: this.orchestrator.taskControllers.has(sessionId),
        stage: run.stage,
        stageLabel: run.stageLabel,
        error: run.error || null,
        seatErrors: run.seatErrors || {},
        outerCycleCount: run.outerCycleCount ?? 1,
        constructionReworkCount: run.constructionReworkCount ?? 0,
        rejectionHistory: run.rejectionHistory ?? [],
        circuitBreaker: run.circuitBreaker ?? null,
        stoppedAll: run.stoppedAll,
        awaitingHumanApproval: run.awaitingHumanApproval,
        userAcceptance: { status: run.userAcceptanceStatus },
        groups: run.groups.map(g => ({
          ...g,
          nativeSessionId: g.childIds?.[g.leaderId] ?? g.members?.find(m => m.nativeSessionId)?.nativeSessionId ?? null
        })),
        independents: run.independents,
        secretary: run.secretary,
        deliverables: run.deliverables,
        queue: run.queue
      } : null,
      sourceSeq: agent?.session?.snapshotEvents?.().at(-1)?.seq ?? 0
    };
  }

  async publishStream(sessionId) {
    if (this.shuttingDown) return;
    for (const s of [...this.streams]) {
      if (!sessionId || s.sessionId === sessionId) {
        if (this.shuttingDown || !s.res || s.res.writableEnded || s.res.destroyed) {
          this.streams.delete(s);
          continue;
        }
        try {
          const snap = await this.snapshot(s.sessionId);
          if (!this.shuttingDown && !s.res.writableEnded && !s.res.destroyed) {
            s.res.write(`data: ${JSON.stringify({ snapshot: snap })}\n\n`);
          }
        } catch {
          this.streams.delete(s);
        }
      }
    }
  }

  broadcastAll() {
    if (this.shuttingDown) return;
    for (const s of [...this.streams]) void this.publishStream(s.sessionId);
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
        this.respond(res, 200, {
          ...this.plans.get(),
          catalog: await this.catalog.getCatalog(),
          runtimeInfo: { pluginPath: this.pluginRoot, planFilePath: this.plans.file, dataRoot: this.dataRoot }
        });
        return;
      }
      if (action === 'catalog') {
        this.respond(res, 200, { ok: true, catalog: await this.catalog.getCatalog({ forceRefresh: url.searchParams.get('refresh') === '1' }) });
        return;
      }
      if (action === 'snapshot') {
        this.respond(res, 200, { ok: true, snapshot: await this.snapshot(url.searchParams.get('sessionId') || 'default-session') });
        return;
      }
      if (action === 'resumePreview') {
        this.respond(res, 200, { ok: true, preview: null });
        return;
      }
      if (action === 'taskHistory') {
        const sid = url.searchParams.get('sessionId') || 'default-session';
        const agent = await this.resolveParentAgent(sid);
        this.respond(res, 200, { ok: true, tasks: this.buildSessionTaskHistory(sid, agent) });
        return;
      }
      if (action === 'completedTasks') {
        const sid = url.searchParams.get('sessionId') || null;
        if (sid) {
          const agent = await this.resolveParentAgent(sid);
          this.buildSessionTaskHistory(sid, agent);
        }
        this.respond(res, 200, { ok: true, tasks: this.historyStore.listCompleted(sid), unavailable: [] });
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
      if (input.action === 'detachConfiguration') {
        this.respond(res, 200, await this.detachConfiguration(input.sessionId));
        return;
      }
      if (input.action === 'groupCommand') {
        this.respond(res, 200, await this.groupCommand(input.sessionId, input.command));
        return;
      }
      if (input.action === 'deleteTask') {
        const cleanup = this.historyStore.deleteTask(input.sessionId, input.taskId);
        await this.publishStream(input.sessionId);
        this.respond(res, 200, { ok: true, cleanup });
        return;
      }
      if (input.action === 'clearDeletedTaskCaches') {
        const cleared = this.historyStore.clearDeletedCaches();
        this.respond(res, 200, { ok: true, cleared });
        return;
      }
      this.respond(res, 400, { ok: false, error: `未知操作：${input.action}` });
    }
  }

  async handleSse(req, res) {
    if (this.shuttingDown) { res.writeHead(503); res.end(); return; }
    if (!this.isAuthenticated(req)) { this.respond(res, 401, { ok: false, error: '未认证' }); return; }
    const url = new URL(req.url, 'http://127.0.0.1');
    const sessionId = url.searchParams.get('sessionId') || 'default-session';
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'connection': 'keep-alive' });
    const entry = { sessionId, res };
    const cleanup = () => this.streams.delete(entry);
    res.on('error', cleanup); res.on('close', cleanup); req.on('close', cleanup); req.on('error', cleanup);
    this.streams.add(entry);
    await this.publishStream(sessionId);
  }
}

export function apply(ctx, config = {}) {
  try { new CabinetV2(ctx, config); } catch {}
}

export default { name, inject, apply };
