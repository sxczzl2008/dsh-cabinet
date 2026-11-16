import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MemoryRouter } from './memory-router.mjs';
import { ModelCatalogService } from './model-catalog.mjs';
import { LlmBridge } from './llm-bridge.mjs';
import { SessionManager, NS, appendPluginRecord } from './session-manager.mjs';
import { CabinetOrchestrator, normalizeConfig, validateCabinetConfig, extractFormalDecision, extractReviewDecision } from './orchestrator.mjs';

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT_DIR = path.resolve(CURRENT_DIR, '..');

export const DEFAULT_PLAN = Object.freeze({
  schemaVersion: 2,
  blankDefaultInitialized: true,
  kind: 'plan',
  id: 'default-cabinet-plan',
  revision: 1,
  slotCount: 3,
  discussionRounds: 3,
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
        const plan = normalizeConfig(existing?.plan ?? existing, 'plan');
        const revision = Number.isSafeInteger(existing?.revision) ? existing.revision : (plan.revision || 1);
        if (!existing?.plan?.blankDefaultInitialized) {
          fs.writeFileSync(this.file, JSON.stringify({ revision, plan: { ...plan, blankDefaultInitialized: true } }, null, 2) + '\n', 'utf8');
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
export const inject = ['sessionController', 'sessionQuery', 'sessions', 'agents'];

export class CabinetV2 {
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.config = config;
    this.shuttingDown = false;
    this.streams = new Set();
    this.sessionModes = new Map();
    this.agentBindings = new Map();
    this.admissions = new Map();
    this.admissionQueues = new Map();
    this.deletionsInProgress = new Set();

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

    ctx.provide('cabinetV2', this);

    const baseHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    this.dataRoot = path.resolve(config.dataRoot || path.join(baseHome, 'cabinet-v2'));
    this.pluginRoot = path.resolve(config.pluginRoot || PLUGIN_ROOT_DIR);
    fs.mkdirSync(this.dataRoot, { recursive: true });

    this.plans = new PlanStore(this.dataRoot);
    this.memory = new MemoryRouter(this.dataRoot);
    this.catalog = new ModelCatalogService(ctx, config);
    this.catalog.subscribeEvents(() => this.broadcastAll());

    this.llmBridge = new LlmBridge(ctx, this.catalog, { customResponder: config.customResponder });
    this.sessionManager = new SessionManager(ctx, this.dataRoot, {
      nativeAppend: config.nativeAppend,
      onGroupConversation: async (binding, childAgent) => {
        if (childAgent) this.attachAgent(childAgent);
        else {
          const agent = await this.resolveParentAgent(binding.childSessionId);
          if (agent) this.attachAgent(agent);
        }
      }
    });
    this.orchestrator = new CabinetOrchestrator({
      llmBridge: this.llmBridge,
      sessionManager: this.sessionManager,
      memoryRouter: this.memory,
      onStateChange: (sessionId) => this.publishStream(sessionId)
    });

    ctx.on('agent/created', ({ agent }) => {
      if (this.sessionManager.findGroupByChildSession(agent.id) || this.getSessionState(agent, agent.id).mode === 'cabinet') this.attachAgent(agent);
    }, { global: true });
    ctx.on('agent/disposed', ({ agent }) => this.detachAgent(agent), { global: true });

    if (ctx.effect) {
      ctx.effect(() => () => {
        this.shuttingDown = true;
        for (const { agent } of [...this.agentBindings.values()]) this.detachAgent(agent);
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

    const discarded = new WeakSet();
    const originalFollowup = agent.followup;
    const originalSteer = agent.steer;
    const model = agent.model;
    const originalSelect = model.select;
    const offDiscarded = agent.ctx.on('agent/inbox/discarded', ({ message }) => discarded.add(message));

    const route = (message, original) => {
      if (discarded.delete(message) && !this.sessionManager.findGroupByChildSession(agent.id)) return original.call(agent, message);
      const nativeGroup = this.sessionManager.findGroupByChildSession(agent.id);
      if (!nativeGroup && this.getSessionState(agent, agent.id).mode !== 'cabinet') return original.call(agent, message);
      if (message.content?.length > 0 && message.source?.kind === 'user' && (nativeGroup || 'rpcId' in message.source)) {
        void this.admit(agent, message).catch(error => {
          const parentId = nativeGroup?.parentSessionId ?? agent.id;
          const run = this.orchestrator.getRun(parentId);
          if (run) { run.error = error.message; run.stageLabel = '指令未接收：' + error.message; this.orchestrator.emit(parentId); }
        });
        return;
      }
      if (nativeGroup) return;
      return original.call(agent, message);
    };
    const followup = message => route(message, originalFollowup);
    const steer = message => route(message, originalSteer);
    const select = selection => this.sessionManager.findGroupByChildSession(agent.id)
      ? undefined
      : this.selectOrdinary(agent, selection, () => originalSelect.call(model, selection));

    agent.followup = followup;
    agent.steer = steer;
    model.select = select;
    this.agentBindings.set(agent.id, {
      agent,
      model,
      originalFollowup,
      originalSteer,
      originalSelect,
      followup,
      steer,
      select,
      offDiscarded
    });
  }

  detachAgent(agent) {
    const binding = this.agentBindings.get(agent.id);
    if (!binding || binding.agent !== agent) return;
    binding.offDiscarded();
    if (agent.followup === binding.followup) agent.followup = binding.originalFollowup;
    if (agent.steer === binding.steer) agent.steer = binding.originalSteer;
    if (binding.model.select === binding.select) binding.model.select = binding.originalSelect;
    this.agentBindings.delete(agent.id);
  }

  getSessionState(agent, sessionId) {
    const id = sessionId || agent?.id || 'default-session';
    if (this.sessionModes.has(id)) return this.releaseCompletedState(agent, this.sessionModes.get(id));
    let mode = 'ordinary';
    let configVersion = 0;
    let config = null;
    let entryChoice = null;
    let lastTask = null;
    const events = agent?.session?.snapshotEvents?.() ?? [];
    const deletedTasks = new Set(events.filter(event => event.type === NS + 'task-deleted').map(event => event.data?.taskId));
    for (const ev of events) {
      if (ev.type === NS + 'transition' && ev.data) {
        configVersion = ev.data.configVersion ?? configVersion;
        if (ev.data.associationDetached === true && ev.data.config === null) {
          lastTask = { taskId: ev.data.detachedTaskId, config, reason: ev.data.reason || 'manual' };
          mode = 'ordinary'; config = null; entryChoice = null;
          continue;
        }
        if (ev.data.config?.taskId && deletedTasks.has(ev.data.config.taskId)) {
          mode = 'ordinary'; config = null; entryChoice = null; continue;
        }
        if (ev.data.config?.blankDefaultInitialized) {
          mode = ev.data.mode || mode;
          config = { ...normalizeConfig(ev.data.config, 'task'), blankDefaultInitialized: true };
          entryChoice = ev.data.entryChoice ?? null;
        }
      }
    }
    if (lastTask && deletedTasks.has(lastTask.taskId)) lastTask = null;
    const request = [...events].reverse().find(event => event.type === NS + 'request' && event.data?.taskId === config?.taskId);
    const state = { sessionId: id, mode, configVersion, config, entryChoice, lastTask, requestText: config ? request?.data?.text ?? null : null };
    this.sessionModes.set(id, state);
    return this.releaseCompletedState(agent, state);
  }

  configurationBusy(sessionId) {
    const run = this.orchestrator.getRun(sessionId);
    return Boolean(run?.activeActor || this.orchestrator.taskControllers.has(sessionId)
      || this.orchestrator.taskFlights.has(sessionId)
      || [...this.orchestrator.groupControllers.keys()].some(key => key.startsWith(sessionId + '::')));
  }

  configurationDelivered(agent, state, { historical = false } = {}) {
    if (!state.config) return false;
    const run = this.orchestrator.getRun(state.sessionId);
    if (this.configurationBusy(state.sessionId) && !(historical && run?.taskId && run.taskId !== state.config.taskId)) return false;
    if (run?.taskId === state.config.taskId && (run.awaitingHumanApproval || run.stoppedAll)) return false;
    try {
      const check = validateCabinetConfig(state.config, 'task');
      if (!check.ok) return false;
      const cfg = check.value, events = agent?.session?.snapshotEvents?.() ?? [];
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify(cfg)).digest('hex');
      const controls = this.sessionManager.readGroupProgress(state.sessionId, 'cabinet::task-controls', cfg.taskId);
      const root = controls.rootProgress;
      const currentRun = run?.taskId === cfg.taskId ? run : null;
      const deliveredStages = ['awaiting-user-acceptance', 'accepted'];
      // A completed group is only one unit of the root workflow. Resuming it
      // must not release the task while approval or a successor is still due.
      if (root && (root.version !== 1 || root.configFingerprint !== fingerprint
        || root.awaitingHumanApproval || root.stoppedAll || !deliveredStages.includes(root.stage))) return false;
      if (currentRun && !deliveredStages.includes(currentRun.stage)) return false;
      const needsHumanApproval = cfg.policies?.humanApprovalRequired
        && cfg.seats.some(seat => seat.inSeat && seat.duties.some(duty => duty.role === 'design'));
      if (needsHumanApproval && !(root ? root.humanApproved === true : currentRun?.humanApproved === true)) {
        if (root) return false;
        // Older records have no root progress; retain their exact, task-owned
        // approval evidence. A resume selection or final acceptance is not it.
        const relays = events.filter(event => event.type === 'user/message' && event.data?.source?.kind === 'cabinet-relay' && event.data.source.taskId === cfg.taskId);
        const approved = events.some(event => event.type === 'user/message' && event.data?.source?.kind !== 'cabinet-relay'
          && /^(认可|认可此版|同意|通过|继续施工)$/.test(event.data?.content?.map(part => part.text || '').join('').trim())
          && relays.some(relay => relay.seq < event.seq)
          && events.some(request => request.type === NS + 'request' && request.data?.taskId === cfg.taskId && request.data.id === event.data.id));
        if (!approved) return false;
      }
      const relay = (id, text) => events.some(event => event.type === 'user/message' && event.data?.id === id
        && event.data.source?.kind === 'cabinet-relay' && event.data.source.taskId === cfg.taskId
        && event.data.content?.every(part => part.type === 'text')
        && event.data.content.map(part => part.text).join('') === String(text).trim());
      const construction = cfg.seats.some(seat => seat.inSeat && seat.duties.some(duty => duty.role === 'construction'));
      const design = cfg.seats.some(seat => seat.inSeat && seat.duties.some(duty => duty.role === 'design'));
      const stageFor = role => role === 'review' ? construction ? 'construction-review' : design ? 'design-review' : null : role;
      let units = 0;
      for (const group of check.groups) {
        units++;
        const cp = this.sessionManager.readGroupCheckpoint(state.sessionId, group.key, cfg.taskId);
        const progress = this.sessionManager.readGroupProgress(state.sessionId, group.key, cfg.taskId);
        if (!cp || cp.status !== 'completed' || cp.nextTurnId || cp.fault || cp.configFingerprint !== fingerprint
          || cp.stageOptions?.stageKey !== stageFor(group.role) || progress.blocked || progress.stopped
          || !progress.handoffReceived || progress.handoffs?.[cp.meetingKey] !== cp.handoffId
          || fs.existsSync(this.sessionManager.groupFile(state.sessionId, group.key, cfg.taskId) + '.lease')) return false;
        if (cp.turns.some(turn => turn.state !== 'skipped' && (turn.state !== 'completed'
          || !turn.entry?.text?.trim() || !turn.entry.nativeCommitted || !Number.isSafeInteger(turn.entry.nativeSeq)))) return false;
        const formal = cp.turns.find(turn => turn.phase === 'formal' && turn.actorId === group.leaderId);
        const decision = extractFormalDecision(formal?.entry?.text);
        if (!decision.ready || progress.formalText !== decision.text || !relay(cp.handoffId, decision.text)
          || group.role === 'review' && extractReviewDecision(decision.text).conclusion !== 'pass') return false;
      }
      const grouped = new Set(check.groups.flatMap(group => group.participantIds.map(id => id + '::' + group.role)));
      for (const seat of cfg.seats.filter(seat => seat.inSeat)) for (const duty of seat.duties) {
        if (duty.kind !== 'independent' && grouped.has(seat.id + '::' + duty.role)) continue;
        const stages = duty.role === 'review'
          ? ['design', 'construction'].filter(target => (target === 'design' ? design : construction) && (duty.reviewTargets ?? ['design', 'construction']).includes(target)).map(target => target + '-review')
          : [stageFor(duty.role)];
        if (!stages.length) continue;
        units++;
        const stored = controls.independentProgress?.[`ind::${seat.id}::${duty.role}`];
        if (!stored || stored.blocked) return false;
        for (const stage of stages) {
          const handoffs = Object.entries(stored.handoffs ?? {}).filter(([key]) => key.startsWith(stage + ':') && key.includes(':revision-' + (controls.reviewRevision ?? 1) + ':'));
          if (!handoffs.length) return false;
          const [stageKey, id] = handoffs.at(-1);
          const presentation = events.find(event => event.type === NS + 'presentation' && event.data?.taskId === cfg.taskId && event.data.messageId === id);
          const original = presentation && this.sessionManager.readOriginal(presentation.data.sourceId);
          if (!original?.text?.trim() || original.sessionId !== state.sessionId || original.taskId !== cfg.taskId
            || original.actorId !== seat.id || original.stageKey !== stageKey || !relay(id, original.text)
            || duty.role === 'review' && extractReviewDecision(original.text).conclusion !== 'pass') return false;
        }
      }
      return units > 0;
    } catch { return false; }
  }

  releaseCompletedState(agent, state) {
    if (!state.config || !this.configurationDelivered(agent, state)) return state;
    const next = { ...state, mode: 'ordinary', configVersion: state.configVersion + 1,
      retiringFromVersion: state.configVersion, config: null, entryChoice: null, requestText: null,
      lastTask: { taskId: state.config.taskId, config: state.config, reason: 'completed' }, pendingRetirement: true };
    this.sessionModes.set(state.sessionId, next);
    if (agent) this.detachAgent(agent);
    return next;
  }

  configurationStarted(agent, state, config = state.config) {
    if (!config) return false;
    const run = this.orchestrator.getRun(state.sessionId);
    const controls = this.sessionManager.readGroupProgress(state.sessionId, 'cabinet::task-controls', config.taskId);
    return Boolean(state.requestText || controls.taskInputs?.userMessage
      || run?.taskId === config.taskId && (run.originalUserMessage || run.lastTaskPrompt)
      || agent?.session?.snapshotEvents?.().some(event => event.type === NS + 'request' && event.data?.taskId === config.taskId)
      || validateCabinetConfig(config, 'task').groups.some(group => this.sessionManager.readGroupCheckpoint(state.sessionId, group.key, config.taskId)));
  }

  async writeConfigurationDetachment(agent, state, reason) {
    const config = state.config ?? state.lastTask?.config;
    if (!config) return state;
    const nextVersion = state.pendingRetirement ? state.configVersion : state.configVersion + 1;
    await appendPluginRecord(agent.session, NS + 'transition', { schemaVersion: 1, mode: 'ordinary',
      previousConfigVersion: state.retiringFromVersion ?? state.configVersion, configVersion: nextVersion, config: null,
      associationDetached: true, detachedTaskId: config.taskId, reason, at: new Date().toISOString() }, this.config.nativeAppend);
    await this.sessionManager.flushNativeSession(agent.session);
    const next = { sessionId: state.sessionId, mode: 'ordinary', configVersion: nextVersion, config: null,
      entryChoice: null, requestText: null, lastTask: { taskId: config.taskId, config, reason } };
    this.sessionModes.set(state.sessionId, next); this.detachAgent(agent);
    // Only an idle, detached run is disposable. All durable history stays put.
    if (!this.configurationBusy(state.sessionId)) this.orchestrator.runs.delete(state.sessionId);
    return next;
  }

  deletionDirectory() { return path.join(this.dataRoot, 'deleted-tasks'); }

  deletionFile(sessionId, taskId) {
    return path.join(this.deletionDirectory(), crypto.createHash('sha256').update(JSON.stringify([sessionId, taskId])).digest('hex') + '.json');
  }

  saveDeletion(record) {
    fs.mkdirSync(this.deletionDirectory(), { recursive: true });
    const file = this.deletionFile(record.parentSessionId, record.taskId), temp = file + '.' + crypto.randomUUID() + '.tmp';
    try { fs.writeFileSync(temp, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' }); fs.renameSync(temp, file); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }

  deletionRecords() {
    const directory = this.deletionDirectory();
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).flatMap(name => {
      try {
        const value = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
        if (value.version !== 1 || value.kind !== 'cabinet-task-deletion' || !value.deletionId
          || !value.parentSessionId || !value.taskId || this.deletionFile(value.parentSessionId, value.taskId) !== path.join(directory, name)) return [];
        return [value];
      } catch { return []; }
    });
  }

  async taskHistory(sessionId, { readOnly = false } = {}) {
    if (this.sessionManager.findGroupByChildSession(sessionId)) throw new Error('请在主对话查看任务历史');
    let agent, state;
    if (readOnly) {
      const saved = await getSvc(this.ctx, 'sessionQuery')?.readSession(sessionId);
      if (saved?.session?.id !== sessionId || !Array.isArray(saved.events)) throw new Error('无法核实主对话历史');
      agent = { id: sessionId, session: { header: saved.session, snapshotEvents: () => saved.events } };
      state = { configVersion: [...saved.events].reverse().find(event => event.type === NS + 'transition')?.data?.configVersion ?? 0 };
    } else {
      agent = await this.resolveParentAgent(sessionId); state = this.getSessionState(agent, sessionId);
    }
    const events = agent?.session?.snapshotEvents?.() ?? [], configurations = new Map();
    const deleted = new Set(events.filter(event => event.type === NS + 'task-deleted').map(event => event.data?.taskId));
    for (const event of events) if (event.type === NS + 'transition' && event.data?.config?.taskId) configurations.set(event.data.config.taskId, event.data);
    const tasks = [...configurations.values()].filter(entry => !deleted.has(entry.config.taskId)).map(entry => {
      const config = entry.config;
      const groups = validateCabinetConfig(config, 'task').groups.map(group => {
        const thread = this.sessionManager.readGroupThread(sessionId, group.key, group.label, config.taskId);
        return { groupKey: group.key, label: group.label, nativeSessionId: thread.nativeSessionId ?? null };
      });
      return { taskId: config.taskId, goal: config.goal || '未命名任务', deleted: false, groups,
        completed: this.configurationDelivered(agent, { sessionId, config, entryChoice: entry.entryChoice ?? null }, { historical: true }) };
    });
    return { ok: true, tasks, configVersion: state.configVersion };
  }

  async completedTasks() {
    const owners = new Map(), unavailable = [];
    const deleted = new Set(this.deletionRecords().filter(record => record.confirmed).map(record => JSON.stringify([record.parentSessionId, record.taskId])));
    const directories = [
      [this.sessionManager.groupStoreDir, 'group'], [this.sessionManager.groupBindingsDir, 'binding'], [this.sessionManager.originalStoreDir, 'original']
    ];
    for (const [directory, category] of directories) for (const name of fs.readdirSync(directory)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(directory, name);
      try {
        const record = JSON.parse(fs.readFileSync(file, 'utf8'));
        const parentId = category === 'binding' ? record.parentSessionId : record.sessionId, taskId = record.taskId;
        if (typeof parentId !== 'string' || !parentId || typeof taskId !== 'string' || !taskId) continue;
        const canonical = category === 'group' ? this.sessionManager.groupFile(parentId, record.groupKey, taskId)
          : category === 'binding' ? this.sessionManager.bindingFile(record)
          : typeof record.sourceId === 'string' && /^[a-zA-Z0-9_-]+$/.test(record.sourceId) ? path.join(directory, record.sourceId + '.json') : null;
        if (canonical !== file || deleted.has(JSON.stringify([parentId, taskId]))) continue;
        if (!owners.has(parentId)) owners.set(parentId, new Set());
        owners.get(parentId).add(taskId);
      } catch { unavailable.push({ record: name, reason: '记录归属无法核实，已保留' }); }
    }
    const tasks = [];
    for (const [parentSessionId, taskIds] of owners) {
      try {
        const history = await this.taskHistory(parentSessionId, { readOnly: true });
        for (const task of history.tasks) if (task.completed && taskIds.has(task.taskId)) tasks.push({ ...task, parentSessionId });
      } catch (error) { unavailable.push({ parentSessionId, reason: error.message }); }
    }
    return { ok: true, tasks, unavailable };
  }

  async deleteTask(sessionId, { taskId, expectedVersion, confirmPermanent } = {}) {
    if (confirmPermanent !== true) throw new Error('永久删除需要明确确认');
    return this.serializeTaskEntry(sessionId, () => this.withDeletionGuard(sessionId, async () => {
      if (this.sessionManager.findGroupByChildSession(sessionId)) throw new Error('请在主对话删除任务');
      const agent = await this.resolveParentAgent(sessionId), state = this.getSessionState(agent, sessionId);
      if (!agent?.session || expectedVersion !== state.configVersion) throw Object.assign(new Error('当前任务已变化，请刷新'), { code: 'TASK_CONFIG_CHANGED' });
      if (this.configurationBusy(sessionId) || this.admissionQueues.has(sessionId)) throw Object.assign(new Error('任务仍在运行，不能删除'), { code: 'TASK_ACTIVE' });
      const events = agent.session.snapshotEvents(), existing = this.deletionRecords().find(item => item.parentSessionId === sessionId && item.taskId === taskId);
      const configuration = [...events].reverse().find(event => event.type === NS + 'transition' && event.data?.config?.taskId === taskId);
      if (!configuration) throw new Error('没有可核实归属的任务记录，未删除');
      const alreadyDeleted = existing && events.some(event => event.type === NS + 'task-deleted' && event.data?.taskId === taskId && event.data.deletionId === existing.deletionId);
      if (!alreadyDeleted && !this.configurationDelivered(agent, { sessionId, config: configuration.data.config, entryChoice: configuration.data.entryChoice ?? null }))
        throw Object.assign(new Error('该任务尚未结束，不能永久删除'), { code: 'TASK_NOT_COMPLETE' });
      let tombstone = existing ?? { version: 1, kind: 'cabinet-task-deletion', parentSessionId: sessionId, taskId,
        deletionId: crypto.randomUUID(), deletedAt: new Date().toISOString(), confirmed: false };
      this.saveDeletion(tombstone);
      if (!events.some(event => event.type === NS + 'task-deleted' && event.data?.deletionId === tombstone.deletionId && event.data.taskId === taskId)) {
        await appendPluginRecord(agent.session, NS + 'task-deleted', { taskId, deletionId: tombstone.deletionId, at: tombstone.deletedAt }, this.config.nativeAppend);
      }
      await this.sessionManager.flushNativeSession(agent.session);
      this.sessionModes.delete(sessionId);
      tombstone = { ...tombstone, confirmed: true }; this.saveDeletion(tombstone);
      const activeConfig = state.config ?? (state.pendingRetirement ? state.lastTask?.config : null);
      if (activeConfig?.taskId === taskId) await this.writeConfigurationDetachment(agent, { ...state, config: activeConfig }, 'deleted');
      else if (state.lastTask?.taskId === taskId) this.sessionModes.set(sessionId, { ...state, lastTask: null });
      const cleanup = await this.cleanDeletedTask(tombstone, agent);
      await this.publishStream(sessionId);
      return { ok: true, tombstone, cleanup, snapshot: await this.snapshot(sessionId) };
    }));
  }

  async withDeletionGuard(sessionId, operation) {
    if (this.deletionsInProgress.has(sessionId)) throw new Error('任务清理正在进行，请稍后重试');
    this.deletionsInProgress.add(sessionId);
    try { return await operation(); } finally { this.deletionsInProgress.delete(sessionId); }
  }

  async cleanDeletedTask(tombstone) {
    const sessionId = tombstone.parentSessionId, taskId = tombstone.taskId;
    const result = { taskId, deletedFiles: 0, deletedBytes: 0, deletedSessions: [], retained: [], blocked: [] };
    if (this.configurationBusy(sessionId) || this.admissionQueues.has(sessionId)) {
      result.blocked.push('主对话有在途任务');
      return result;
    }
    const { internalFiles, nativeSessions } = this.sessionManager.collectTaskAssets(sessionId, taskId);
    const persistence = getSvc(this.ctx, 'sessionPersistence');
    const projection = getSvc(this.ctx, 'sessionProjectionCache');
    const registry = getSvc(this.ctx, 'workspaceRegistry');

    for (const id of nativeSessions) {
      try {
        if (id === sessionId || getSvc(this.ctx, 'agents')?.get?.(id) || getSvc(this.ctx, 'sessions')?.get?.(id)) {
          throw new Error('组聊仍在使用中，暂留');
        }
        if (registry && (registry.list?.().some(w => w.sessionIds?.includes(id))
          || registry.archivedSessionIds?.includes(id) || registry.pinnedSessionIds?.includes(id))) {
          throw new Error('组聊仍有工作区或回收站引用，暂留');
        }
        if (typeof persistence?.delete === 'function') {
          await persistence.delete(id);
          result.deletedSessions.push(id);
        }
        if (typeof projection?.remove === 'function') {
          await projection.remove(id);
        }
      } catch (error) {
        result.blocked.push({ sessionId: id, reason: error.message });
      }
    }

    if (!result.blocked.length) {
      for (const file of internalFiles) {
        try {
          if (fs.existsSync(file)) {
            const bytes = fs.statSync(file).size;
            fs.unlinkSync(file);
            result.deletedFiles++;
            result.deletedBytes += bytes;
          }
        } catch (error) {
          result.blocked.push({ path: file, reason: error.message });
        }
      }
      for (const [id, binding] of this.sessionManager.childBindings) {
        if (binding.parentSessionId === sessionId && binding.taskId === taskId) {
          this.sessionManager.childBindings.delete(id);
        }
      }
      const run = this.orchestrator.getRun(sessionId);
      if (run?.taskId === taskId && !this.configurationBusy(sessionId)) {
        this.orchestrator.runs.delete(sessionId);
      }
    }
    return result;
  }

  async clearDeletedTaskCaches({ confirmPermanent } = {}) {
    if (confirmPermanent !== true) throw new Error('永久清理需要明确确认');
    const results = [];
    for (const tombstone of this.deletionRecords()) results.push(await this.serializeTaskEntry(tombstone.parentSessionId,
      () => this.withDeletionGuard(tombstone.parentSessionId, () => this.cleanDeletedTask(tombstone))));
    return { ok: true, results };
  }

  async retireCompletedConfiguration(sessionId, parentAgent = null) {
    return this.serializeTaskEntry(sessionId, async () => {
      const agent = parentAgent ?? await this.resolveParentAgent(sessionId);
      const state = this.getSessionState(agent, sessionId);
      if (state.pendingRetirement && !this.configurationBusy(sessionId)) await this.writeConfigurationDetachment(agent, state, 'completed');
      await this.publishStream(sessionId);
    });
  }

  observeTaskCompletion(sessionId, parentAgent, promise) {
    void promise.catch(error => {
      const run = this.orchestrator.getRun(sessionId);
      if (run) { run.error = error.message; this.orchestrator.emit(sessionId); }
    }).then(() => this.retireCompletedConfiguration(sessionId, parentAgent)).catch(() => {});
  }

  async detachConfiguration(sessionId, { taskId, expectedVersion } = {}) {
    return this.serializeTaskEntry(sessionId, async () => {
      if (this.sessionManager.findGroupByChildSession(sessionId)) throw new Error('请在主对话移除配置关联');
      const agent = await this.resolveParentAgent(sessionId), state = this.getSessionState(agent, sessionId);
      const config = state.config ?? (state.pendingRetirement ? state.lastTask?.config : null);
      if (!agent?.session || !config || config.taskId !== taskId || expectedVersion !== state.configVersion) throw Object.assign(new Error('当前配置关联已变化，请刷新'), { code: 'TASK_CONFIG_CHANGED' });
      if (this.configurationBusy(sessionId) || this.admissionQueues.has(sessionId)) throw Object.assign(new Error('本次任务仍在运行，不能移除配置关联'), { code: 'TASK_ACTIVE' });
      const started = this.configurationStarted(agent, state, config);
      if (started && !state.pendingRetirement && !this.configurationDelivered(agent, state)) throw Object.assign(new Error('本次任务尚未完成，不能移除配置关联'), { code: 'TASK_NOT_COMPLETE' });
      await this.writeConfigurationDetachment(agent, state, 'manual');
      await this.publishStream(sessionId);
      return { ok: true, snapshot: await this.snapshot(sessionId) };
    });
  }

  async snapshot(sessionId) {
    const nativeGroup = this.sessionManager.findGroupByChildSession(sessionId);
    if (nativeGroup) {
      const parent = await this.snapshot(nativeGroup.parentSessionId);
      if (parent.config?.taskId !== nativeGroup.taskId) {
        const thread = this.sessionManager.readGroupThread(nativeGroup.parentSessionId, nativeGroup.groupKey, nativeGroup.groupLabel, nativeGroup.taskId);
        const cfg = [...((await this.resolveParentAgent(nativeGroup.parentSessionId))?.session?.snapshotEvents?.() ?? [])].reverse()
          .find(event => event.type === NS + 'transition' && event.data?.config?.taskId === nativeGroup.taskId)?.data.config;
        return { ...parent, sessionId, mode: 'cabinet-group', config: null, task: null, run: null,
          nativeGroup, readOnly: true, archivedTaskId: nativeGroup.taskId, archivedTaskGoal: cfg?.goal ?? '', canDetachConfiguration: false,
          collaboration: { taskId: nativeGroup.taskId, stage: 'history', stageLabel: '历史记录 · 只读', groups: [{ ...(validateCabinetConfig(cfg ?? {}, 'task').groups.find(group => group.key === nativeGroup.groupKey) ?? {}),
            key: nativeGroup.groupKey, label: nativeGroup.groupLabel, ...thread.progress,
            members: (cfg?.seats ?? []).map(seat => ({ id: seat.id, label: seat.label, model: seat.model })) }],
            independents: [], subteams: [], originals: thread.rounds.flatMap(round => round.messages), deliverables: [], queue: [] } };
      }
      const child = await this.resolveParentAgent(sessionId);
      if (child) this.attachAgent(child);
      return { ...parent, sessionId, mode: 'cabinet-group', nativeGroup,
        sourceSeq: (child?.session?.snapshotEvents?.().at(-1)?.seq ?? 0) + parent.sourceSeq };
    }
    const agent = await this.resolveParentAgent(sessionId);
    const state = this.getSessionState(agent, sessionId);
    if (agent && state.mode === 'cabinet') this.attachAgent(agent);
    const catalog = await this.catalog.getCatalog();
    const workspaceRoot = agent?.session?.header?.cwd || process.cwd();
    const run = state.config ? this.orchestrator.ensureRun(sessionId, state.config, workspaceRoot) : null;
    if (run && state.requestText) {
      run.lastTaskPrompt ??= state.requestText;
      run.originalUserMessage ??= state.requestText;
      run.taskGoalText ??= state.config.goal;
    }

    return {
      sessionId,
      mode: state.mode,
      configVersion: state.configVersion,
      config: state.config,
      task: state.config,
      associatedTaskId: state.config?.taskId ?? (state.pendingRetirement ? state.lastTask?.taskId : null),
      canDetachConfiguration: Boolean(state.config || state.pendingRetirement) && !this.configurationBusy(sessionId)
        && (!this.configurationStarted(agent, state) || Boolean(state.pendingRetirement)),
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
    if (this.shuttingDown) return;
    for (const s of [...this.streams]) {
      const childBinding = this.sessionManager.findGroupByChildSession(s.sessionId);
      if (!sessionId || s.sessionId === sessionId || childBinding?.parentSessionId === sessionId) {
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

  async applyTask(sessionId, rawConfig, expectedVersion, { entryChoice = null } = {}) {
    return this.serializeTaskEntry(sessionId, () => this._applyTask(sessionId, rawConfig, expectedVersion, { entryChoice }));
  }

  async serializeTaskEntry(sessionId, operation) {
    this.taskEntryOperations ??= new Map();
    const prior = this.taskEntryOperations.get(sessionId) ?? Promise.resolve();
    const pending = prior.catch(() => {}).then(operation);
    this.taskEntryOperations.set(sessionId, pending);
    try { return await pending; }
    finally { if (this.taskEntryOperations.get(sessionId) === pending) this.taskEntryOperations.delete(sessionId); }
  }

  async _applyTask(sessionId, rawConfig, expectedVersion, { entryChoice = null } = {}) {
    if (entryChoice !== 'new') throw Object.assign(new Error('请明确选择「新建独立任务」'), { code: 'TASK_SELECTION_REQUIRED' });
    const check = validateCabinetConfig(rawConfig, 'task');
    if (!check.ok) {
      throw Object.assign(new Error(check.errors[0]?.message || '任务配置不完整'), { code: 'INVALID_TASK', errors: check.errors });
    }
    const agent = await this.resolveParentAgent(sessionId);
    const prev = this.getSessionState(agent, sessionId);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== prev.configVersion) throw Object.assign(new Error('本对话配置已变化，请刷新后重新选择'), { code: 'TASK_CONFIG_CHANGED' });
    const nextVersion = (Number.isSafeInteger(expectedVersion) ? expectedVersion : prev.configVersion) + 1;
    if (this.sessionManager.findGroupByChildSession(sessionId)) throw new Error('请在主对话配置任务');
    const activeRun = this.orchestrator.getRun(sessionId);
    if (activeRun?.activeActor || this.configurationBusy(sessionId)) throw new Error('本次任务进行中，请结束后再应用配置');
    const config = { ...check.value, taskId: 'task-' + crypto.randomUUID(), configVersion: nextVersion, blankDefaultInitialized: true };

    const nextState = { sessionId, mode: 'cabinet', configVersion: nextVersion, config, entryChoice: 'new', requestText: null };
    this.sessionModes.set(sessionId, nextState);
    if (agent) this.attachAgent(agent);

    if (agent?.session) {
      try {
        await appendPluginRecord(agent.session, NS + 'transition', {
          schemaVersion: 1,
          mode: 'cabinet',
          previousConfigVersion: prev.configVersion,
          configVersion: nextVersion,
          config,
          entryChoice: 'new',
          at: new Date().toISOString()
        }, this.config.nativeAppend);
        await this.sessionManager.flushNativeSession(agent.session);
      } catch (error) { this.sessionModes.set(sessionId, prev); throw error; }
    }

    const workspaceRoot = agent?.session?.header?.cwd || process.cwd();
    this.orchestrator.ensureRun(sessionId, config, workspaceRoot);
    await this.publishStream(sessionId);
    return { ok: true, snapshot: await this.snapshot(sessionId) };
  }

  async getResumePreview(sessionId) {
    const nativeGroup = this.sessionManager.findGroupByChildSession(sessionId);
    if (nativeGroup) sessionId = nativeGroup.parentSessionId;
    const parentAgent = await this.resolveParentAgent(sessionId);
    const state = this.getSessionState(parentAgent, sessionId);
    if (!state.config) return { ok: false, missing: ['本对话尚无已保存任务'], completed: [] };
    if (nativeGroup && nativeGroup.taskId !== state.config.taskId) throw new Error('这条组聊属于另一项任务，请回主对话查看');
    const run = this.orchestrator.ensureRun(sessionId, state.config, parentAgent?.session?.header?.cwd || process.cwd());
    if (state.requestText) {
      run.lastTaskPrompt ??= state.requestText;
      run.originalUserMessage ??= state.requestText;
      run.taskGoalText ??= state.config.goal;
    }
    return this.orchestrator.getResumePreview(sessionId, parentAgent);
  }

  async resumeCheckpoint(sessionId, { checkpointId, taskId, entryChoice, secretaryModel } = {}) {
    if (entryChoice !== 'resume' || !checkpointId || !taskId) throw Object.assign(new Error('请明确选择「接续此任务」并核对断点'), { code: 'CHECKPOINT_SELECTION_REQUIRED' });
    const nativeGroup = this.sessionManager.findGroupByChildSession(sessionId);
    if (nativeGroup) sessionId = nativeGroup.parentSessionId;
    return this.serializeTaskEntry(sessionId, () => this._resumeCheckpoint(sessionId, { checkpointId, taskId, entryChoice, nativeGroup, secretaryModel }));
  }

  async _resumeCheckpoint(sessionId, { checkpointId, taskId, entryChoice, nativeGroup, secretaryModel }) {
    if (entryChoice !== 'resume') throw Object.assign(new Error('请明确选择「接续此任务」并核对断点'), { code: 'CHECKPOINT_SELECTION_REQUIRED' });
    const parentAgent = await this.resolveParentAgent(sessionId);
    const state = this.getSessionState(parentAgent, sessionId);
    if (!parentAgent?.session) throw Object.assign(new Error('原主对话暂时无法核实，已停止接续'), { code: 'CHECKPOINT_PARENT_UNAVAILABLE' });
    if (taskId !== state.config?.taskId || (nativeGroup && nativeGroup.taskId !== taskId)) throw Object.assign(new Error('任务已变化，请刷新后重新选择'), { code: 'CHECKPOINT_TASK_CHANGED' });
    const preview = await this.getResumePreview(sessionId);
    if (!preview.ok || preview.checkpointId !== checkpointId || preview.taskId !== taskId) throw Object.assign(new Error((preview.missing || []).join('；') || '断点已变化，请刷新后重新选择'), { code: 'CHECKPOINT_PREFLIGHT_FAILED', errors: (preview.missing || []).map(message => ({ message })) });
    let selectedSecretary;
    if (secretaryModel !== undefined && secretaryModel !== null) {
      if (preview.kind !== 'root-finalizing' || !preview.canChangeSecretaryModel) throw Object.assign(new Error('当前断点不需要更换秘书模型，请刷新后继续'), { code: 'SECRETARY_MODEL_CHANGE_UNAVAILABLE' });
      const catalog = await this.catalog.getCatalog({ forceRefresh: true });
      const selected = catalog.models.find(model => model.providerId === secretaryModel.providerId && model.modelId === secretaryModel.modelId);
      if (!selected) throw Object.assign(new Error('所选秘书模型已不在当前模型目录，请重新选择'), { code: 'SECRETARY_MODEL_NOT_LISTED' });
      selectedSecretary = { ...selected, reasoningEffort: secretaryModel.reasoningEffort ?? selected.defaultEffort ?? null };
    }
    const manualSpeechToken = preview.manualSpeechOnly
      ? this.sessionManager.authorizeManualSpeechResume(preview.manualSpeechOnly) : null;
    await appendPluginRecord(parentAgent.session, NS + 'transition', { schemaVersion: 1, mode: 'cabinet', previousConfigVersion: state.configVersion, configVersion: state.configVersion, config: state.config, entryChoice: 'resume', at: new Date().toISOString() }, this.config.nativeAppend);
    await this.sessionManager.flushNativeSession(parentAgent.session);
    this.sessionModes.set(sessionId, { ...state, mode: 'cabinet', entryChoice: 'resume' });
    this.attachAgent(parentAgent);
    const result = await this.orchestrator.resumeCheckpoint(sessionId, parentAgent, { checkpointId, manualSpeechToken, secretaryModel: selectedSecretary });
    const completedState = this.getSessionState(parentAgent, sessionId);
    if (completedState.pendingRetirement && !this.configurationBusy(sessionId)) await this.writeConfigurationDetachment(parentAgent, completedState, 'completed');
    await this.publishStream(sessionId);
    return { ok: true, result, snapshot: await this.snapshot(sessionId) };
  }

  selectOrdinary(agent, selection, doSelect) {
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
          void appendPluginRecord(agent.session, NS + 'transition', {
            schemaVersion: 1,
            mode: 'ordinary',
            previousConfigVersion: prev.configVersion,
            configVersion: nextVersion,
            config: prev.config,
            at: new Date().toISOString()
          }, this.config.nativeAppend).catch(error => { const run = this.orchestrator.getRun(sessionId); if (run) { run.error = error.message; this.orchestrator.emit(sessionId); } });
        } catch (error) { const run = this.orchestrator.getRun(sessionId); if (run) run.error = error.message; }
      }
      void this.publishStream(sessionId);
    }
    this.detachAgent(agent);
    if (typeof doSelect === 'function') return doSelect();
  }

  async admit(parentAgent, message, request) {
    const sessionId = parentAgent?.id;
    if (!sessionId) throw new Error('缺少原生会话身份');
    const owner = this.sessionManager.findGroupByChildSession(sessionId)?.parentSessionId ?? sessionId;
    if (this.deletionsInProgress.has(owner)) throw new Error('任务清理正在进行，请稍后再发送');
    const text = Array.isArray(message?.content)
      ? message.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
      : String(message?.content ?? '');
    if (!text.trim()) return;
    const prior = parentAgent.session?.snapshotEvents?.() ?? [];
    if (message.id && prior.some(event => (event.type === NS + 'request' && event.data?.id === message.id) || (event.type === NS + 'control' && event.data?.incomingId === message.id))) return;
    const admissionKey = sessionId + '::' + (message.id || message.source?.rpcId || crypto.randomUUID());
    if (this.admissions.has(admissionKey)) return this.admissions.get(admissionKey);
    const priorFlight = this.admissionQueues.get(sessionId) ?? Promise.resolve();
    const pending = priorFlight.catch(() => {}).then(() => this.admitText(parentAgent, message, text));
    this.admissionQueues.set(sessionId, pending);
    this.admissions.set(admissionKey, pending);
    try { return await pending; }
    catch (error) { this.admissions.delete(admissionKey); throw error; }
    finally { if (this.admissionQueues.get(sessionId) === pending) this.admissionQueues.delete(sessionId); }
  }

  async admitText(parentAgent, message, text) {
    const sessionId = parentAgent.id;
    const commandText = text.trim();
    const nativeGroup = this.sessionManager.findGroupByChildSession(sessionId);
    if (nativeGroup) {
      const parent = await this.resolveParentAgent(nativeGroup.parentSessionId);
      const parentState = this.getSessionState(parent, nativeGroup.parentSessionId);
      if (parentState.config?.taskId !== nativeGroup.taskId) throw new Error('这条组聊已结束，请在当前任务组聊中发送');
      if (!parentState.entryChoice) throw Object.assign(new Error('旧任务仅可查看候选断点；请回主对话明确选择任务'), { code: 'TASK_SELECTION_REQUIRED' });
      const run = this.orchestrator.ensureRun(nativeGroup.parentSessionId, parentState.config, parent?.session?.header?.cwd);
      const group = run.groups.find(item => item.key === nativeGroup.groupKey);
      if (!group) throw new Error('未找到本组任务归属');
      if (/^(?:停止|叫停|停下|停止本组|\/stop)$/i.test(commandText)) {
        this.orchestrator.stopGroup(nativeGroup.parentSessionId, nativeGroup.groupKey);
        await appendPluginRecord(parentAgent.session, NS + 'control', { ...nativeGroup, id: message.id || crypto.randomUUID(), incomingId: message.id, text, status: 'stopped', at: new Date().toISOString() }, this.config.nativeAppend);
      } else {
        const queued = this.orchestrator.enqueueInstruction(nativeGroup.parentSessionId, { groupKey: nativeGroup.groupKey, selector: 'next', text });
        await appendPluginRecord(parentAgent.session, NS + 'control', { ...nativeGroup, id: queued.id, incomingId: message.id, text, status: 'queued', at: queued.at }, this.config.nativeAppend);
      }
      await this.publishStream(nativeGroup.parentSessionId);
      await this.publishStream(sessionId);
      return;
    }
    let state = this.getSessionState(parentAgent, sessionId);
    if (state.mode !== 'cabinet' || !state.config) {
      throw Object.assign(new Error('请先开启内阁，明确选择「接续此任务」或「新建独立任务」'), { code: 'TASK_SELECTION_REQUIRED' });
    }
    if (!state.entryChoice) throw Object.assign(new Error('旧任务仅可查看候选断点；请明确选择「新建独立任务」或核实后接续'), { code: 'TASK_SELECTION_REQUIRED' });
    const existing = this.orchestrator.getRun(sessionId)
      ?? (state.requestText ? this.orchestrator.ensureRun(sessionId, state.config, parentAgent.session?.header?.cwd) : null);
    if (existing && !existing.lastTaskPrompt && state.requestText) existing.lastTaskPrompt = state.requestText;
    if (existing?.activeActor || this.orchestrator.taskControllers.has(sessionId)) {
      this.orchestrator.enqueueInstruction(sessionId, { selector: 'next', text });
      await this.publishStream(sessionId);
      return;
    }
    const isResume = /^(?:继续|重试|恢复|继续任务)$/.test(commandText) && Boolean(existing?.lastTaskPrompt || state.requestText);
    if (isResume) throw Object.assign(new Error('请开启内阁并明确选择「接续此任务」，核对完成位置和下一席'), { code: 'CHECKPOINT_SELECTION_REQUIRED' });
    const isApproval = existing?.awaitingHumanApproval && /^(?:认可|认可此版|同意|通过|继续施工)$/.test(commandText);
    const isAcceptance = existing?.userAcceptanceStatus === 'awaiting-user' && /^(?:验收通过|确认验收)$/.test(commandText);
    if ((existing?.lastTaskPrompt || state.requestText) && !isApproval && !isAcceptance) {
      this.orchestrator.enqueueInstruction(sessionId, { selector: 'next', text });
      await this.publishStream(sessionId);
      return;
    }
    if (!isApproval && !isAcceptance && state.entryChoice !== 'new') throw Object.assign(new Error('旧任务仅可查看候选断点；请明确选择「新建独立任务」'), { code: 'TASK_SELECTION_REQUIRED' });
    const taskId = state.config.taskId;
    const config = { ...state.config, taskId };
    const taskPrompt = isApproval || isAcceptance ? (existing.lastTaskPrompt || state.requestText || text) : text;
    const nextState = { ...state, config, requestText: taskPrompt };
    const priorMessages = parentAgent.session?.snapshotEvents?.() ?? [];
    if (!message.id || !priorMessages.some(event => event.type === 'user/message' && event.data?.id === message.id)) {
      parentAgent.session.append('user/message', message, { surfaceOp: 'append' });
    }
    await appendPluginRecord(parentAgent.session, NS + 'transition', { schemaVersion: 1, mode: 'cabinet', previousConfigVersion: state.configVersion, configVersion: state.configVersion, config, entryChoice: state.entryChoice, at: new Date().toISOString() }, this.config.nativeAppend);
    this.sessionModes.set(sessionId, nextState);
    await appendPluginRecord(parentAgent.session, NS + 'request', { id: message.id || crypto.randomUUID(), taskId, text: taskPrompt, at: new Date().toISOString() }, this.config.nativeAppend);
    await this.sessionManager.flushNativeSession(parentAgent.session);
    const workspaceRoot = parentAgent.session?.header?.cwd || process.cwd();
    const run = this.orchestrator.ensureRun(sessionId, config, workspaceRoot);
    this.observeTaskCompletion(sessionId, parentAgent, this.orchestrator.runTask(sessionId, parentAgent, isApproval || isAcceptance ? text : taskPrompt));
    await this.publishStream(sessionId);
  }

  async groupCommand(sessionId, command = {}) {
    const nativeGroup = this.sessionManager.findGroupByChildSession(sessionId);
    if (nativeGroup) {
      if (command.groupKey && command.groupKey !== nativeGroup.groupKey) throw new Error('组聊指令归属不匹配');
      command = { ...command, groupKey: nativeGroup.groupKey };
      sessionId = nativeGroup.parentSessionId;
    }
    if (this.deletionsInProgress.has(sessionId)) throw new Error('任务清理正在进行，请稍后重试');
    const parentAgent = await this.resolveParentAgent(sessionId);
    const state = this.getSessionState(parentAgent, sessionId);
    const workspaceRoot = parentAgent?.session?.header?.cwd || process.cwd();
    const run = state.config ? this.orchestrator.ensureRun(sessionId, state.config, workspaceRoot) : this.orchestrator.getRun(sessionId);
    if (!run) throw new Error('请先应用本任务配置');
    if (!run.lastTaskPrompt && state.requestText) run.lastTaskPrompt = state.requestText;
    if ((nativeGroup && nativeGroup.taskId !== run.taskId) || command.taskId !== run.taskId) throw new Error('这条指令属于另一项任务，请刷新本任务组聊');

    const action = command.action;
    if (!state.entryChoice && !['stop', 'stop-group', 'stop-all'].includes(action)) throw Object.assign(new Error('旧任务仅可查看候选断点；请明确选择任务'), { code: 'TASK_SELECTION_REQUIRED' });
    let result = { ok: true, action };

    if (action === 'stop-group' || (action === 'stop' && command.groupKey)) {
      this.orchestrator.stopGroup(sessionId, command.groupKey);
    } else if (action === 'stop-all' || action === 'stop') {
      this.orchestrator.stopAll(sessionId);
    } else if (action === 'queue-instruction') {
      const queued = this.orchestrator.enqueueInstruction(sessionId, {
        groupKey: command.groupKey || null,
        selector: command.selector || 'next',
        participantId: command.participantId || null,
        text: command.text || ''
      });
      result = { ok: true, instruction: queued };
    } else if (action === 'approve-design') {
      if (!run.awaitingHumanApproval) throw new Error('当前没有待确认的设计');
      await appendPluginRecord(parentAgent.session, NS + 'control', { taskId: run.taskId, action, at: new Date().toISOString() }, this.config.nativeAppend);
      await this.sessionManager.flushNativeSession(parentAgent.session);
      this.observeTaskCompletion(sessionId, parentAgent, this.orchestrator.runTask(sessionId, parentAgent, '认可此版'));
    } else if (action === 'reject-design') {
      if (!run.awaitingHumanApproval) throw new Error('当前没有待确认的设计');
      await appendPluginRecord(parentAgent.session, NS + 'control', { taskId: run.taskId, action, text: command.text || '', at: new Date().toISOString() }, this.config.nativeAppend);
      await this.sessionManager.flushNativeSession(parentAgent.session);
      run.awaitingHumanApproval = false;
      run.humanApproved = false;
      if (run.designArtifact) run.designArtifact.approved = false;
      run.round += 1;
      run.rootPosition = { designAttempt: 1, designFeedback: '' };
      this.orchestrator.persistGlobalInstructions(run);
      for (const group of run.groups.filter(group => group.role === 'design')) {
        group.stopped = false;
        this.orchestrator.enqueueInstruction(sessionId, { groupKey: group.key, selector: 'next', text: command.text || '退回修改设计方案' });
      }
      this.observeTaskCompletion(sessionId, parentAgent, this.orchestrator.runTask(sessionId, parentAgent, run.lastTaskPrompt || run.config.goal));
    } else if (action === 'start' || action === 'run') {
      if (run.lastTaskPrompt || state.requestText || state.entryChoice !== 'new') throw Object.assign(new Error('请开启内阁并明确选择「接续此任务」或「新建独立任务」'), { code: 'TASK_SELECTION_REQUIRED' });
      this.observeTaskCompletion(sessionId, parentAgent, this.orchestrator.runTask(sessionId, parentAgent, command.text || run.config.goal || '开始执行任务'));
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
      if (action === 'resumePreview') {
        this.respond(res, 200, { ok: true, preview: await this.getResumePreview(url.searchParams.get('sessionId') || 'default-session') });
        return;
      }
      if (action === 'taskHistory') {
        this.respond(res, 200, await this.taskHistory(url.searchParams.get('sessionId') || 'default-session'));
        return;
      }
      if (action === 'completedTasks') {
        this.respond(res, 200, await this.completedTasks());
        return;
      }
      if (action === 'readGroupConversation') {
        const sessionId = url.searchParams.get('sessionId') || 'default-session';
        const groupId = url.searchParams.get('groupId') || '';
        const snap = await this.snapshot(sessionId);
        const taskId = snap.config?.taskId ?? (snap.readOnly && snap.nativeGroup?.groupKey === groupId ? snap.nativeGroup.taskId : null);
        if (!taskId || !snap.collaboration?.groups?.some(group => group.key === groupId)) throw new Error('未找到本任务工作组');
        const thread = this.sessionManager.readGroupThread(snap.nativeGroup?.parentSessionId || sessionId, groupId, '工作组', taskId);
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
        this.respond(res, 200, await this.applyTask(input.sessionId, input.config, input.expectedVersion, { entryChoice: input.entryChoice }));
        return;
      }
      if (input.action === 'detachConfiguration') {
        this.respond(res, 200, await this.detachConfiguration(input.sessionId, input));
        return;
      }
      if (input.action === 'deleteTask') {
        this.respond(res, 200, await this.deleteTask(input.sessionId, input));
        return;
      }
      if (input.action === 'clearDeletedTaskCaches') {
        this.respond(res, 200, await this.clearDeletedTaskCaches(input));
        return;
      }
      if (input.action === 'resumeCheckpoint') {
        this.respond(res, 200, await this.resumeCheckpoint(input.sessionId, input));
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
    if (this.shuttingDown) {
      res.writeHead(503);
      res.end();
      return;
    }
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
    const cleanup = () => this.streams.delete(entry);
    res.on('error', cleanup);
    res.on('close', cleanup);
    req.on('close', cleanup);
    req.on('error', cleanup);
    this.streams.add(entry);
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

export default { name, inject, apply };


