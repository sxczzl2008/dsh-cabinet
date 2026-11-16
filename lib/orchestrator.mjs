import crypto from 'node:crypto';
import path from 'node:path';
import { shortenModelName } from './model-catalog.mjs';
import { MainConversationContext, MAIN_CONTEXT_TOOL } from './main-context.mjs';

export const ROLE_LABELS = Object.freeze({
  design: '设计',
  construction: '施工',
  review: '审验',
  secretary: '秘书'
});

export const KIND_LABELS = Object.freeze({
  independent: '独立',
  leader: '组长',
  member: '组员'
});

export const DEFAULT_POLICIES = Object.freeze({
  handoff: 'wait',
  humanApprovalRequired: false,
  memberPool: { scope: 'group', seatIds: [] }
});

const TASK_CONTROL_KEY = 'cabinet::task-controls';
const FINAL_DELIVERY_SUMMARY = '本轮全部工作组与独立席已完成交付，现呈交完整成果并等待你验收。';

export function resolveDiscussionRounds(raw = {}) {
  if (!Object.prototype.hasOwnProperty.call(raw, 'discussionRounds')) return 3;
  const rounds = raw.discussionRounds;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) {
    throw Object.assign(new Error('讨论轮数须为 1–5 的整数'), { code: 'INVALID_DISCUSSION_ROUNDS' });
  }
  return rounds;
}

export function extractFormalDecision(text = '') {
  const raw = String(text).trim();
  if (!raw) return { ready: false, text: '', blockers: ['组长未返回有效的正式成果内容'] };
  const block = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = block ? block[1].trim() : raw;
  if (candidate.startsWith('{') && candidate.endsWith('}')) {
    try {
      const parsed = JSON.parse(candidate);
      const blockers = Array.isArray(parsed?.blockers) ? parsed.blockers.map(String).filter(s => s.trim()) : [];
      const formalText = typeof parsed?.text === 'string' ? parsed.text.trim() : '';
      if (parsed?.ready === true && formalText && blockers.length === 0) return { ready: true, text: formalText, blockers: [] };
      if (parsed?.ready === false || blockers.length > 0) {
        return { ready: false, text: formalText, blockers: blockers.length ? blockers : ['组长尚未确认可交付成果'] };
      }
    } catch {}
  }
  return { ready: true, text: raw, blockers: [] };
}

function stableId(prefix, ...parts) {
  return `${prefix}-${crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`;
}

function checkpointFingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function checkpointError(code, message) {
  return Object.assign(new Error(message), { code });
}

function groupMessages(sessions, run, group) {
  const thread = sessions.readGroupThread(run.sessionId, group.key, group.label, run.taskId);
  return (thread?.rounds ?? []).flatMap(round => round.messages ?? [])
    .map((message, index) => ({ ...message, _order: index }))
    .sort((a, b) => (a.sequence ?? a._order) - (b.sequence ?? b._order));
}

function discussionContext(sessions, run, group) {
  const checkpoint = sessions.readGroupCheckpoint?.(run.sessionId, group.key, run.taskId);
  return groupMessages(sessions, run, group).filter(message => message.nativeCommitted === true
    && typeof message.text === 'string' && message.text.trim()
    && (!checkpoint || checkpoint.turns.some(turn => turn.state === 'completed'
      && turn.turnId === message.turnId && turn.actorId === message.actorId && turn.entry?.text === message.text))
    && (!group.activeMeetingKey || message.stageKey === group.activeMeetingKey)).map(message => {
    const paths = (message.toolRecords ?? []).map(tool => tool.fullPath || tool.path).filter(Boolean);
    return `【${message.actorLabel || message.actorId} · ${message.phase === 'opening' ? '开场' : message.phase === 'formal' ? '正式成果' : `讨论第 ${message.discussionRound ?? message.round ?? 1} 轮`}】\n${message.text}${paths.length ? `\n【实际工具路径】\n${paths.join('\n')}` : ''}`;
  }).join('\n\n');
}

// These task-bound inputs are sent directly to every working seat. A leader's
// allocation and the initiating chat message cannot replace the configured goal.
function taskTurnContext(sessions, run, { seat, role, roleBadge, groupKey, independentKey, stageTitle, stageKey, phase, discussionRound }) {
  const stageIdentity = String(stageKey ?? '').split(':meeting-')[0];
  const deliveries = [];
  const deliveryAcceptance = run.userAcceptanceStatus === 'accepted' ? '用户已验收' : '用户未验收';
  const states = run.groups.map(group => {
    const committed = groupMessages(sessions, run, group).filter(message => message.phase === 'formal'
      && group.handoffs?.[message.stageKey]);
    const formal = committed.filter(message => String(message.stageKey ?? '').split(':meeting-')[0] === stageIdentity).at(-1);
    const previous = committed.at(-1);
    const decision = formal ? extractFormalDecision(formal.text) : null;
    const delivered = decision?.ready === true;
    if (group.key !== groupKey && delivered) {
      deliveries.push(`【${group.label} · 已交付正式成果 · ${deliveryAcceptance}】\n${decision.text}`);
    }
    const status = delivered ? `本阶段已交付正式成果，${deliveryAcceptance}`
      : group.blocked ? '受阻，尚未交付'
      : group.stopped ? '已停止，尚未交付'
      : group.key === groupKey ? '当前组进行中，尚未交付'
      : group.role === role ? `本阶段待办，尚未交付${previous ? `；此前${previous.stageTitle || '阶段'}已交付` : ''}`
      : previous ? `${previous.stageTitle || '此前阶段'}已交付正式成果，${deliveryAcceptance}` : '后续阶段待办，尚未交付';
    return `${group.label}：${status}`;
  });
  for (const ind of run.independents) {
    const ref = ind.formalOutputRef;
    const saved = ref && ind.handoffs?.[ref.stageKey] ? sessions.readOriginal(ref.sourceId) : null;
    const original = saved?.taskId === run.taskId && saved.actorId === ind.id && saved.role === ind.role
      && saved.phase === 'independent' && saved.stageKey === ref.stageKey ? saved : null;
    const delivered = original && String(original.stageKey).split(':meeting-')[0] === stageIdentity;
    if (delivered && ind.key !== independentKey) {
      deliveries.push(`【${ind.label} · 已交付正式成果 · ${deliveryAcceptance}】\n${original.text}`);
    }
    const status = delivered ? `本阶段已交付正式成果，${deliveryAcceptance}`
      : ind.blocked ? '受阻，尚未交付'
      : ind.key === independentKey ? '当前独立席进行中，尚未交付'
      : ind.role === role ? `本阶段待办，尚未交付${original ? '；此前阶段已交付' : ''}`
      : original ? `此前阶段已交付正式成果，${deliveryAcceptance}` : '后续阶段待办，尚未交付';
    states.push(`${ind.label}：${status}${ind.reviewConclusion ? `；审验结论：${ind.reviewConclusion}` : ''}`);
  }
  const acceptance = run.userAcceptanceStatus === 'accepted' ? '用户已验收'
    : run.userAcceptanceStatus === 'awaiting-user' ? '成果已交付，等待用户验收' : '用户尚未验收';
  const progress = [
    `当前阶段：${stageTitle}；本棒席位：${seat.label}；职责：${roleBadge}；棒次：${phase}${discussionRound ? `，第 ${discussionRound} 轮` : ''}。`,
    `总任务用于持续锚定目标，不要求每个席位重复执行全部待办；本棒分工和组长发言须服从总任务与用户约束。发起消息可能只是招呼，不能因此丢弃任务栏目标。`,
    `接续前序已经提交的工作；已交付的成果作为后续输入，不从头重做。${acceptance}。${run.awaitingHumanApproval ? '设计正在等待本人确认，尚未获准施工。' : ''}`,
    `设计成果：${run.designArtifact ? run.awaitingHumanApproval ? '已交付，等待本人确认' : run.designArtifact.approved ? '已交付，已获流程认可' : '已形成，尚未认可' : '尚未形成汇总成果'}；施工成果：${run.constructionArtifact ? '已交付，用户尚未验收' : '尚未形成汇总成果'}。`,
    ...run.groups.filter(group => group.role === 'review' && group.reviewConclusion).map(group => `${group.label}审验结论：${group.reviewConclusion}`),
    ...states,
    ...deliveries
  ].join('\n\n');
  const instructions = run.queue.filter(item => item.groupKey === groupKey || (!item.groupKey && item.targetId === 'next'))
    .map(item => `【${item.id} · ${item.status === 'delivered' ? '已交付' : '待交付'}】${item.text}`).join('\n');
  return `【发起本次内阁的用户消息原文】\n${run.originalUserMessage ?? run.lastTaskPrompt ?? ''}\n\n【本次子代「任务」栏原文】\n${run.taskGoalText ?? run.config.goal ?? ''}\n\n【同任务用户纠正与指令交付状态】\n${instructions}\n\n【本棒分工与流程上下文】\n${progress}`;
}

function existingFormalRelay(parentAgent, messageId, taskId, text) {
  if (!messageId || !parentAgent?.session?.snapshotEvents) return false;
  return parentAgent.session.snapshotEvents().some(event => event.type === 'user/message'
    && event.data?.id === messageId
    && event.data.source?.kind === 'cabinet-relay'
    && event.data.source.taskId === taskId
    && Array.isArray(event.data.content)
    && event.data.content.every(part => part?.type === 'text' && typeof part.text === 'string')
    && event.data.content.map(part => part.text).join('') === String(text ?? '').trim());
}

function mergeContextUsage(...maps) {
  const merged = {};
  for (const map of maps) {
    if (map != null && (typeof map !== 'object' || Array.isArray(map))) {
      throw Object.assign(new Error('主对话读取额度记录无效'), { code: 'MAIN_CONTEXT_BUDGET' });
    }
    for (const [key, usage] of Object.entries(map ?? {})) {
      if (!usage || typeof usage !== 'object' || Array.isArray(usage)
        || Object.keys(usage).some(field => !['pages', 'bytes', 'lookups', 'initial', 'formal'].includes(field))
        || [['pages', 3], ['bytes', 12288], ['lookups', 2]].some(([field, limit]) =>
          field in usage && (!Number.isSafeInteger(usage[field]) || usage[field] < 0 || usage[field] > limit))
        || ['initial', 'formal'].some(field => field in usage && typeof usage[field] !== 'boolean')) {
        throw Object.assign(new Error('主对话读取额度记录无效'), { code: 'MAIN_CONTEXT_BUDGET' });
      }
      const previous = merged[key] ?? {};
      merged[key] = {
        pages: Math.max(previous.pages ?? 0, usage.pages ?? 0),
        bytes: Math.max(previous.bytes ?? 0, usage.bytes ?? 0),
        lookups: Math.max(previous.lookups ?? 0, usage.lookups ?? 0),
        initial: previous.initial === true || usage.initial === true,
        formal: previous.formal === true || usage.formal === true
      };
    }
  }
  return merged;
}

export function normalizeConfig(raw = {}, kind = 'task') {
  const policies = {
    handoff: raw.policies?.handoff || DEFAULT_POLICIES.handoff,
    humanApprovalRequired: raw.policies?.humanApprovalRequired === true,
    memberPool: raw.policies?.memberPool?.scope
      ? { scope: raw.policies.memberPool.scope, seatIds: Array.isArray(raw.policies.memberPool.seatIds) ? raw.policies.memberPool.seatIds : [] }
      : { ...DEFAULT_POLICIES.memberPool }
  };

  const toModelRef = ref => {
    if (ref && typeof ref === 'object' && (ref.providerId || ref.provider) && (ref.modelId || ref.model)) {
      const providerId = ref.providerId ?? ref.provider;
      const modelId = ref.modelId ?? ref.model;
      return {
        providerId,
        providerName: ref.providerName ?? providerId,
        modelId,
        displayName: ref.displayName ?? ref.label ?? modelId,
        shortLabel: ref.shortLabel ?? shortenModelName(modelId, ref.displayName ?? ref.label),
        reasoningEffort: ref.reasoningEffort ?? null,
        reasoningEffortOptions: Array.isArray(ref.reasoningEffortOptions) ? ref.reasoningEffortOptions : []
      };
    }
    if (typeof ref === 'string' && ref.includes('::')) {
      const [providerId, modelId] = ref.split('::');
      return { providerId, providerName: providerId, modelId, displayName: modelId, shortLabel: shortenModelName(modelId, modelId), reasoningEffort: null, reasoningEffortOptions: [] };
    }
    return null;
  };

  const rawSeats = (Array.isArray(raw.seats) ? raw.seats : [])
    .filter(s => s && toModelRef(s.model ?? s.modelRef))
    .slice(0, 9);
  const activeIds = Array.isArray(raw.participants) && raw.participants.length
    ? new Set(raw.participants)
    : new Set(rawSeats.filter(s => s.inSeat !== false).map(s => s.id));

  const instanceCounts = new Map();
  const seats = rawSeats.map((s, idx) => {
    const id = s.id || `seat-${idx + 1}`;
    const model = toModelRef(s.model ?? s.modelRef);
    const key = `${model.providerId}::${model.modelId}`;
    const count = (instanceCounts.get(key) ?? 0) + 1;
    instanceCounts.set(key, count);
    const duties = (Array.isArray(s.duties) ? s.duties : []).map(d => {
      const role = ['design', 'construction', 'review'].includes(d.role) ? d.role : 'design';
      const dutyKind = ['independent', 'leader', 'member'].includes(d.kind) ? d.kind : 'independent';
      const groupId = dutyKind === 'independent' ? null : (d.groupId || `${role}-group`);
      const groupName = dutyKind === 'independent' ? null : (d.groupName || `${ROLE_LABELS[role]}组`);
      return {
        role,
        kind: dutyKind,
        ...(groupId ? { groupId, groupName } : {}),
        ...(role === 'review' ? { reviewTargets: Array.isArray(d.reviewTargets) && d.reviewTargets.length ? d.reviewTargets : ['design', 'construction'] } : {})
      };
    });
    return {
      id,
      seatIndex: Number.isInteger(s.seatIndex) ? s.seatIndex : idx,
      inSeat: s.inSeat !== false && (kind === 'plan' || activeIds.has(id)),
      instanceNumber: count,
      label: s.label || (count > 1 ? `${model.shortLabel} · ${count}` : model.shortLabel),
      model,
      duties
    };
  });

  const staging = Array.isArray(raw.staging) ? raw.staging : [];
  const rawSecRef = raw.secretary?.model ?? raw.secretary?.modelRef;
  const secretaryModel = rawSecRef ? toModelRef(rawSecRef) : null;
  const maxSeatIdx = seats.reduce((m, s) => Math.max(m, (s.seatIndex ?? 0) + 1), 0);
  const slotCount = Math.min(9, Math.max(1, Number.isInteger(raw.slotCount) ? raw.slotCount : Math.max(3, maxSeatIdx)));

  return {
    schemaVersion: 2,
    kind,
    id: raw.id || (kind === 'plan' ? 'default-cabinet-plan' : (raw.taskId || 'cabinet-task')),
    taskId: raw.taskId || raw.id || 'cabinet-task',
    revision: Number.isSafeInteger(raw.revision) ? raw.revision : 1,
    configVersion: Number.isSafeInteger(raw.configVersion) ? raw.configVersion : 1,
    slotCount,
    discussionRounds: Object.prototype.hasOwnProperty.call(raw, 'discussionRounds') ? raw.discussionRounds : 3,
    goal: String(raw.goal ?? ''),
    constraints: String(raw.constraints ?? ''),
    existingDesign: raw.existingDesign ?? null,
    secretary: {
      id: 'secretary',
      model: secretaryModel,
      label: secretaryModel ? `秘书 · ${secretaryModel.shortLabel}` : '秘书（未配置）'
    },
    seats,
    staging,
    participants: seats.filter(s => s.inSeat && s.duties.length > 0).map(s => s.id),
    policies
  };
}

export function validateCabinetConfig(raw, kind = 'task') {
  const config = normalizeConfig(raw, kind);
  const errors = [];
  const warnings = [];
  try { resolveDiscussionRounds(raw); } catch (err) { errors.push({ code: err.code, message: err.message }); }
  const allCards = [...config.seats, ...(config.staging ?? [])];

  const groupLeaders = new Map();
  for (const card of allCards) {
    for (const d of card.duties ?? []) {
      if (d.kind === 'leader') {
        const gKey = `${d.role}::${d.groupId || `${d.role}-group`}`;
        const existing = groupLeaders.get(gKey);
        if (existing && existing.id !== card.id) {
          errors.push({
            code: 'DUPLICATE_LEADER',
            groupKey: gKey,
            message: `先移除 ${existing.label} 的${ROLE_LABELS[d.role]}组长标签`
          });
        } else {
          groupLeaders.set(gKey, card);
        }
      }
    }
  }

  const seated = config.seats.filter(s => s.inSeat && s.duties.length > 0);
  if (kind === 'task' && seated.length === 0) {
    errors.push({ code: 'NO_PARTICIPANTS', message: '请至少将一个模型拖入工作席并分配职责' });
  }

  const groupBuckets = new Map();
  for (const seat of seated) {
    for (const d of seat.duties) {
      if (d.kind !== 'independent') {
        const gKey = `${d.role}::${d.groupId || `${d.role}-group`}`;
        if (!groupBuckets.has(gKey)) {
          groupBuckets.set(gKey, {
            key: gKey,
            groupId: d.groupId || `${d.role}-group`,
            role: d.role,
            label: d.groupName || `${ROLE_LABELS[d.role]}组`,
            leaders: [],
            members: [],
            participants: []
          });
        }
        const g = groupBuckets.get(gKey);
        g.participants.push(seat);
        if (d.kind === 'leader') g.leaders.push(seat);
        else g.members.push(seat);
      }
    }
  }

  const groups = [];
  for (const g of groupBuckets.values()) {
    if (g.leaders.length === 0) {
      errors.push({ code: 'MISSING_LEADER', groupKey: g.key, message: `${g.label}还缺组长 · 请将组长气泡拖给本组成员，或改为独立` });
    } else if (g.members.length === 0 || g.participants.length < 2) {
      errors.push({ code: 'MISSING_MEMBER', groupKey: g.key, message: `${g.label}至少需要 1 名组长和 1 名组员 · 单人请设为独立` });
    } else {
      groups.push({
        key: g.key,
        groupId: g.groupId,
        role: g.role,
        label: g.label,
        leaderId: g.leaders[0].id,
        leaderLabel: g.leaders[0].label,
        memberIds: g.members.map(m => m.id),
        participantIds: g.participants.map(p => p.id)
      });
    }
  }

  const hasConstruction = seated.some(s => s.duties.some(d => d.role === 'construction'));
  const hasDesign = seated.some(s => s.duties.some(d => d.role === 'design'));
  const hasReview = seated.some(s => s.duties.some(d => d.role === 'review'));

  if (kind === 'task' && hasConstruction && !hasDesign && !config.existingDesign?.artifactRef && !config.existingDesign?.text) {
    warnings.push({ code: 'EXISTING_DESIGN_HINT', message: '未配置设计席，施工前可选择现成设计方案或增加设计席' });
  }
  if (kind === 'task' && (hasDesign || hasConstruction) && !hasReview) {
    warnings.push({ code: 'REVIEW_HINT', message: '当前未分配审验席，可为现有席位增加审验标签或由本人确认审验' });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    value: config,
    groups
  };
}

export function extractReviewDecision(text = '') {
  const raw = String(text || '').trim();
  const blockMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = blockMatch ? blockMatch[1].trim() : raw;
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object') {
      const c = String(parsed.conclusion ?? parsed.decision ?? parsed.status ?? '').toLowerCase();
      const conclusion = c.includes('change') || c.includes('reject') || c.includes('rework') || c.includes('退回') ? 'changes' : 'pass';
      const issues = Array.isArray(parsed.issues) ? parsed.issues.map(String) : [];
      return { conclusion, issues, summary: String(parsed.summary ?? parsed.comment ?? raw).trim() };
    }
  } catch {}
  const lower = raw.toLowerCase();
  if (lower.includes('[退回修改]') || lower.includes('结论：退回') || lower.includes('conclusion: changes') || lower.includes('"conclusion":"changes"')) {
    const issueLines = raw.split(/\r?\n/).filter(l => /^[-*•\d.]/.test(l.trim())).map(l => l.replace(/^[-*•\d.]+\s*/, '').trim()).filter(Boolean);
    return { conclusion: 'changes', issues: issueLines.length ? issueLines : [raw.slice(0, 200)], summary: raw };
  }
  return { conclusion: 'pass', issues: [], summary: raw };
}

export class CabinetOrchestrator {
  constructor({ llmBridge, sessionManager, memoryRouter, onStateChange }) {
    this.llm = llmBridge;
    this.sessions = sessionManager;
    this.memory = memoryRouter;
    this.onStateChange = onStateChange;
    this.runs = new Map();
    this.groupControllers = new Map();
    this.taskControllers = new Map();
    this.taskFlights = new Map();
    this.mainContext = new MainConversationContext();
  }

  getRun(sessionId) { return this.runs.get(sessionId) ?? null; }

  async readResumeCheckpoint(run, group) {
    return this.sessions.readGroupCheckpoint(run.sessionId, group.key, run.taskId);
  }

  async getResumePreview(sessionId, parentAgent = null) {
    const run = this.runs.get(sessionId);
    if (run?.stage === 'finalizing-delivery') return this.getFinalDeliveryPreview(run, parentAgent);
    const missing = [];
    const candidates = [];
    const completedCandidates = [];
    const finished = [];
    const legacyCandidates = [];
    if (!run) return { ok: false, missing: ['当前任务配置不可用'], completed: [] };
    for (const group of run.groups) {
      let cp;
      try { cp = await this.readResumeCheckpoint(run, group, parentAgent); }
      catch (error) { missing.push(`${group.label}：${error.message}`); continue; }
      if (cp?.status !== 'completed' && cp) candidates.push({ group, cp });
      if (cp?.status === 'completed') {
        const binding = this.sessions.findGroupConversation({ parentSessionId: sessionId, taskId: run.taskId, groupId: group.groupId, groupKey: group.key });
        let needsRepair = false;
        for (const turn of cp.turns.filter(t => t.state === 'completed')) {
          try {
            const speech = binding && await this.sessions.readGroupSpeech(binding, turn.turnId);
            if (speech?.data.entry.text === turn.entry?.text) finished.push({ actorId: turn.actorId, phase: turn.phase, discussionRound: turn.discussionRound });
            else needsRepair = true;
          } catch { missing.push(`${group.label}：已完成发言证据暂不可核实`); }
        }
        const formal = extractFormalDecision(cp.turns.find(turn => turn.phase === 'formal')?.entry?.text);
        if (formal.ready && parentAgent && !existingFormalRelay(parentAgent, cp.handoffId, run.taskId, formal.text)) needsRepair = true;
        if (needsRepair) candidates.push({ group, cp });
        else completedCandidates.push({ group, cp });
      }
      if (!cp) {
        const messages = groupMessages(this.sessions, run, group).filter(m => m.nativeCommitted && String(m.text ?? '').trim());
        const verified = [];
        const gaps = ['缺少能确定下一棒的原讨论执行位置或阶段材料'];
        const binding = this.sessions.findGroupConversation({ parentSessionId: sessionId, taskId: run.taskId, groupId: group.groupId, groupKey: group.key });
        for (const message of messages) {
          try {
            const speech = binding && await this.sessions.readGroupSpeech(binding, message.turnId ?? message.id);
            if (speech?.data.entry.text === message.text && speech.data.entry.actorId === message.actorId) verified.push(message);
            else gaps.push(`席位 ${message.actorId} 仅有本地记录，原生发言待核对`);
          } catch { gaps.push(`席位 ${message.actorId} 原生发言暂不可核实`); }
        }
        if (messages.length || group.lastSpeechFailure) legacyCandidates.push({ groupKey: group.key, label: group.label,
          completed: verified.map(m => ({ actorId: m.actorId, phase: m.phase, discussionRound: m.discussionRound })),
          fault: group.lastSpeechFailure ?? null, missing: gaps });
      }
    }
    // A completed group can still be followed by review, approval or another
    // stage. Keep an explicit route back into that existing task workflow.
    if (!candidates.length && completedCandidates.length && !run.awaitingHumanApproval
      && !['awaiting-user-acceptance', 'accepted'].includes(run.stage)) {
      candidates.push(completedCandidates.sort((a, b) => String(b.cp.updatedAt ?? b.cp.createdAt).localeCompare(String(a.cp.updatedAt ?? a.cp.createdAt)))[0]);
    }
    if (candidates.length !== 1) return { ok: false, completed: [...finished, ...legacyCandidates.flatMap(c => c.completed)], legacyCandidates,
      fault: legacyCandidates.find(c => c.fault)?.fault ?? null,
      missing: [...missing, ...legacyCandidates.flatMap(c => c.missing), candidates.length > 1 ? '存在多个未完成讨论，无法确定唯一接续断点' : '没有可核实的未完成讨论'] };
    const { group, cp } = candidates[0];
    if (cp.version !== 1 || cp.taskId !== run.taskId || cp.groupKey !== group.key) missing.push('断点版本或任务归属不一致');
    if (path.resolve(cp.workspaceRoot ?? '') !== path.resolve(run.workspaceRoot)) missing.push('工作区与原讨论不一致');
    if (cp.configFingerprint !== checkpointFingerprint(run.config)) missing.push('任务配置或原席位顺序已改变');
    if (!cp.taskConfig || checkpointFingerprint(cp.taskConfig) !== cp.configFingerprint) missing.push('原席位配置材料缺失或校验不一致');
    if (typeof cp.taskInputs?.userMessage !== 'string' || !cp.taskInputs.userMessage.trim()) missing.push('缺少原发起消息');
    if (typeof cp.taskInputs?.goal !== 'string') missing.push('缺少原任务栏文本');
    if (typeof cp.promptContext !== 'string' || !cp.promptContext.trim()) missing.push('缺少原阶段简报');
    if (group.stageContexts?.[cp.meetingKey] !== undefined && group.stageContexts[cp.meetingKey] !== cp.promptContext) missing.push('阶段简报与原组记录不一致');
    if (cp.inputFingerprint !== checkpointFingerprint({ taskInputs: cp.taskInputs, promptContext: cp.promptContext })) missing.push('原材料校验不一致');
    if (run.originalUserMessage !== cp.taskInputs?.userMessage || run.taskGoalText !== cp.taskInputs?.goal) missing.push('当前任务输入与断点不一致');
    if (!Array.isArray(cp.turns) || !cp.turns.length || new Set(cp.turns?.map(t => t.turnId)).size !== cp.turns?.length) missing.push('逻辑棒次不完整');
    const options = cp.stageOptions;
    const seatOrder = [group.leaderId, ...group.memberIds];
    if (!options || typeof options.stageTitle !== 'string' || !options.stageTitle.trim()
      || !Number.isSafeInteger(options.attempt) || options.attempt < 1
      || typeof options.allowWrite !== 'boolean' || typeof options.isReview !== 'boolean'
      || options.rounds !== run.config.discussionRounds || JSON.stringify(cp.seatOrder) !== JSON.stringify(seatOrder)) missing.push('原讨论调度材料缺失或不一致');
    else {
      const plan = [{ actorId: group.leaderId, phase: 'opening', discussionRound: 0 },
        ...Array.from({ length: options.rounds }, (_, index) => group.memberIds.map(actorId => ({ actorId, phase: 'member', discussionRound: index + 1 }))).flat(),
        { actorId: group.leaderId, phase: 'formal', discussionRound: 0 }];
      if (JSON.stringify(plan) !== JSON.stringify(cp.turns.map(({ actorId, phase, discussionRound }) => ({ actorId, phase, discussionRound })))) missing.push('原席位棒次计划不一致');
    }
    const expected = cp.turns?.find(turn => !['completed', 'skipped'].includes(turn.state));
    if ((expected?.turnId ?? null) !== cp.nextTurnId) missing.push('下一席进度不一致');
    let nativeEvents = [], binding = null;
    try {
      binding = this.sessions.findGroupConversation({ parentSessionId: sessionId, taskId: run.taskId, groupId: group.groupId, groupKey: group.key });
      if (!binding || binding.state !== 'ready') missing.push('原生讨论绑定不可用');
      else {
        const snapshot = await this.sessions.ctx.sessionQuery.readSession(binding.childSessionId);
        if (snapshot.session?.id !== binding.childSessionId || snapshot.inheritedEventCount !== 0) missing.push('原生讨论身份不一致');
        if (path.resolve(binding.workspaceRoot ?? '') !== path.resolve(run.workspaceRoot)
          || path.resolve(snapshot.session?.cwd ?? '') !== path.resolve(run.workspaceRoot)) missing.push('原生讨论工作区与断点不一致');
        nativeEvents = (snapshot.events ?? []).filter(event => event.type === 'plugin:cabinet-v2/speech');
        for (const event of nativeEvents) this.sessions.validateGroupSpeech(binding, event);
        const owner = snapshot.events?.find(event => event.type === 'plugin:cabinet-v2/group-binding')?.data;
        if (!owner || ['parentSessionId', 'taskId', 'groupId', 'groupKey', 'creationAttemptId'].some(key => owner[key] !== binding[key])) missing.push('原生讨论归属证据缺失');
      }
    } catch (error) { missing.push(error.code === 'GROUP_MESSAGE_IDENTITY' ? error.message : '无法只读核实原生讨论'); }
    const toolUncertainties = [];
    const localMessages = groupMessages(this.sessions, run, group);
    for (const turn of cp.turns ?? []) {
      const entry = turn.entry ?? this.sessions.readOriginal(stableId('orig', run.taskId, turn.turnId));
      const speeches = nativeEvents.filter(event => event.data.entry?.turnId === turn.turnId || event.data.entry?.id === turn.turnId);
      const native = speeches[0]?.data.entry;
      if (turn.state !== 'skipped') for (const event of speeches) {
        try { this.sessions.validateGroupSpeech(binding, event, turn, cp); }
        catch (error) { missing.push(error.message); }
      }
      const reliableEntry = entry?.text?.trim() && entry.taskId === cp.taskId && entry.sessionId === cp.sessionId
        && entry.groupKey === cp.groupKey && entry.actorId === turn.actorId && entry.turnId === turn.turnId
        && entry.stageKey === cp.meetingKey && entry.phase === turn.phase && entry.discussionRound === turn.discussionRound;
      if (turn.state === 'completed' && (!reliableEntry || native && (!String(native.text ?? '').trim()
        || native.actorId !== turn.actorId || native.stageKey !== cp.meetingKey
        || native.text !== entry?.text))) missing.push(`已完成席位 ${turn.actorId} 的有效发言证据缺失`);
      if ((turn.state === 'uncertain' || turn.sideEffectsUncertain) && ![entry, native].some(item => String(item?.text ?? '').trim())) {
        const local = localMessages.filter(item => item.turnId === turn.turnId || item.id === turn.turnId);
        toolUncertainties.push({ turnId: turn.turnId,
          hasSavedText: [...local, turn.entry, this.sessions.readOriginal(stableId('orig', run.taskId, turn.turnId)), native]
            .some(item => String(item?.text ?? '').trim()),
          message: `席位 ${turn.actorId} 的工具副作用无法核实，禁止自动重跑` });
      }
    }
    const pendingLeader = expected?.actorId === group.leaderId && (!expected.entry || expected.phase === 'formal')
      ? expected : !expected ? cp.turns?.at(-1) : null;
    group.discussionRound = cp.currentRound ?? expected?.discussionRound ?? 0;
    group.round = group.discussionRound || 1;
    run.round = cp.reviewRevision ?? run.round;
    run.stage = cp.runStage ?? run.stage;
    if (cp.fault) run.error = cp.fault.reason ?? cp.fault.message ?? null;
    const next = (cp.turns ?? []).find(turn => !['completed', 'skipped'].includes(turn.state) && !String(turn.entry?.text ?? '').trim()) ?? expected;
    const manualSpeechOnly = !missing.length && toolUncertainties.length === 1
      && toolUncertainties[0].turnId === expected?.turnId && !toolUncertainties[0].hasSavedText
      && !expected.entry && !localMessages.some(item => item.turnId === expected.turnId || item.id === expected.turnId)
      ? this.sessions.manualSpeechResumeDescriptor(cp) : null;
    return { ok: missing.length === 0 && (!toolUncertainties.length || Boolean(manualSpeechOnly)),
      manualSpeechOnly, checkpointId: cp.meetingId, taskId: run.taskId, groupKey: group.key,
      completed: (cp.turns ?? []).filter(t => t.state === 'completed').map(({ actorId, phase, discussionRound }) => ({ actorId, phase, discussionRound })),
      nextSeat: next ? { actorId: next.actorId, label: run.config.seats.find(s => s.id === next.actorId)?.label ?? next.actorId,
        phase: next.phase, discussionRound: next.discussionRound } : null,
      fault: cp.fault ?? group.lastSpeechFailure ?? (cp.failureEvidence ? { reason: cp.failureEvidence } : null),
      missing: [...missing, ...toolUncertainties.map(item => item.message)], legacyCandidates };
  }

  async getFinalDeliveryPreview(run, parentAgent = null) {
    const missing = [], completed = [], references = [];
    const saved = this.sessions.readGroupProgress(run.sessionId, TASK_CONTROL_KEY, run.taskId).rootProgress;
    const finalId = stableId('deliv', run.sessionId, run.taskId, run.constructionArtifact?.version, run.designArtifact?.version);
    const delivery = run.deliverables.find(item => item.id === finalId);
    if (!saved || saved.version !== 1 || saved.stage !== 'finalizing-delivery'
      || saved.configFingerprint !== checkpointFingerprint(run.config)) missing.push('已保存的任务收尾位置或配置不一致');
    if (!delivery || !saved?.deliverables?.some(item => checkpointFingerprint(item) === checkpointFingerprint(delivery))
      || delivery.designText !== (run.designArtifact?.text || '')
      || delivery.constructionText !== (run.constructionArtifact?.text || '')) missing.push('已交付成果与保存的收尾材料不一致');
    if (run.awaitingHumanApproval) missing.push('设计仍待本人确认，尚不能进入最终收尾');
    try {
      parentAgent ??= this.sessions.ctx.agents?.get?.(run.sessionId)
        ?? (await this.sessions.ctx.sessionController?.resolveAgent(run.sessionId))?.agent;
      if (parentAgent?.id !== run.sessionId || typeof parentAgent.session?.snapshotEvents !== 'function') throw new Error('原任务主对话暂不可读');
      for (const ind of run.independents) {
        const ref = ind.formalOutputRef;
        if (!ref) {
          if (ind.role === 'construction' || ind.role === 'design' && !run.config.existingDesign?.approved) missing.push(`${ind.label}：缺少已交付成果索引`);
          continue;
        }
        const original = this.sessions.readOriginal(ref.sourceId);
        if (!original || original.taskId !== run.taskId || original.sessionId !== run.sessionId || original.actorId !== ind.id
          || original.role !== ind.role || original.phase !== 'independent' || original.stageKey !== ref.stageKey
          || !original.text?.trim() || !existingFormalRelay(parentAgent, ind.handoffs?.[ref.stageKey], run.taskId, original.text)) {
          missing.push(`${ind.label}：原稿或主对话交付记录不一致`); continue;
        }
        references.push({ actorId: ind.id, stageKey: ref.stageKey, sourceId: ref.sourceId, handoffId: ind.handoffs[ref.stageKey] });
        completed.push({ actorId: ind.id, label: ind.label, phase: 'independent', discussionRound: null });
      }
      for (const group of run.groups) {
        const cp = this.sessions.readGroupCheckpoint(run.sessionId, group.key, run.taskId);
        if (!cp) {
          if (group.role === 'construction' || group.role === 'design' && !run.config.existingDesign?.approved) missing.push(`${group.label}：缺少已交付讨论记录`);
          continue;
        }
        const formal = cp.turns.find(turn => turn.phase === 'formal');
        const decision = extractFormalDecision(formal?.entry?.text);
        if (cp.status !== 'completed' || !decision.ready || !existingFormalRelay(parentAgent, cp.handoffId, run.taskId, decision.text)) {
          missing.push(`${group.label}：原正式成果或主对话交付记录不一致`); continue;
        }
        references.push({ groupKey: group.key, meetingId: cp.meetingId, handoffId: cp.handoffId, sourceId: formal.entry.sourceId });
        completed.push(...cp.turns.filter(turn => turn.state === 'completed').map(({ actorId, phase, discussionRound }) => ({ actorId, phase, discussionRound })));
      }
    } catch (error) { missing.push(error.message || '无法核实原任务已交付成果'); }
    const details = delivery ? [delivery.designText, delivery.constructionText].filter(Boolean).join('\n\n') : '';
    const reportSourceId = stableId('orig-secretary', run.sessionId, run.taskId, run.round, 'final', FINAL_DELIVERY_SUMMARY, details);
    const report = this.sessions.readOriginal(reportSourceId);
    if (report && (report.sessionId !== run.sessionId || report.taskId !== run.taskId || report.kind !== 'secretary-final'
      || report.actorId !== 'secretary' || !report.text?.trim())) missing.push('已保存的秘书原稿归属或正文无效');
    const secretaryModel = run.secretaryModelOverride ?? run.config.secretary?.model ?? null;
    const checkpointId = stableId('cab-root-finalizing', run.sessionId, run.taskId, checkpointFingerprint(run.config),
      saved, delivery ?? null, references, secretaryModel, report?.sourceId ?? null);
    return { ok: missing.length === 0, kind: 'root-finalizing', checkpointId, taskId: run.taskId, groupKey: null,
      completed, nextSeat: secretaryModel ? { actorId: 'secretary', label: run.secretary?.label ?? '秘书', phase: 'secretary-final', discussionRound: null } : null,
      secretaryModel, canChangeSecretaryModel: !report?.text?.trim(),
      fault: run.error || run.secretary?.error ? { code: 'SECRETARY_FINAL_FAILED', reason: run.error || run.secretary.error } : null,
      missing, legacyCandidates: [] };
  }

  async resumeFinalDelivery(run, parentAgent, preview, secretaryModel) {
    const sessionId = run.sessionId;
    if (this.taskFlights.has(sessionId) || this.taskControllers.has(sessionId)) throw checkpointError('CHECKPOINT_BUSY', '本任务正在执行，请等待当前请求结束');
    const current = await this.getFinalDeliveryPreview(run, parentAgent);
    if (!current.ok || current.checkpointId !== preview.checkpointId) throw checkpointError('CHECKPOINT_PREFLIGHT_FAILED', current.missing.join('；') || '任务收尾记录已变化');
    if (this.taskFlights.has(sessionId) || this.taskControllers.has(sessionId)) throw checkpointError('CHECKPOINT_BUSY', '本任务正在执行，请等待当前请求结束');
    const priorOverride = run.secretaryModelOverride;
    const priorSecretary = structuredClone(run.secretary);
    const priorError = run.error, priorStageLabel = run.stageLabel, priorStopped = run.stoppedAll;
    if (secretaryModel) {
      if (!current.canChangeSecretaryModel) throw checkpointError('CHECKPOINT_RESULT_EXISTS', '秘书已有正文，只能补交原稿，不能替换模型重写');
      if (typeof secretaryModel.providerId !== 'string' || !secretaryModel.providerId || typeof secretaryModel.modelId !== 'string' || !secretaryModel.modelId) throw checkpointError('SECRETARY_MODEL_INVALID', '秘书模型缺少明确提供方或模型标识');
      run.secretaryModelOverride = normalizeConfig({ ...run.config, secretary: { model: secretaryModel } }).secretary.model;
      run.secretary ??= { reports: [] };
      run.secretary.model = run.secretaryModelOverride;
      run.secretary.label = `秘书 · ${run.secretaryModelOverride.shortLabel}`;
    }
    const taskCtrl = new AbortController();
    this.taskControllers.set(sessionId, taskCtrl);
    run.stoppedAll = false; run.error = null;
    run.stageLabel = '正在补完秘书总结与主对话交付';
    try { this.emit(sessionId); }
    catch (error) {
      run.secretaryModelOverride = priorOverride; run.secretary = priorSecretary;
      run.error = priorError; run.stageLabel = priorStageLabel; run.stoppedAll = priorStopped;
      if (this.taskControllers.get(sessionId) === taskCtrl) this.taskControllers.delete(sessionId);
      throw error;
    }
    const promise = (async () => {
      try {
        const finalId = stableId('deliv', run.sessionId, run.taskId, run.constructionArtifact?.version, run.designArtifact?.version);
        await this._completeFinalDelivery(run, parentAgent, run.deliverables.find(item => item.id === finalId), taskCtrl.signal);
        return { stopped: run.stage !== 'awaiting-user-acceptance', run };
      } catch (error) {
        if (!taskCtrl.signal.aborted) { run.error = error.message; run.stageLabel = `秘书收尾受阻：${error.message}`; this.emit(sessionId); }
        return { stopped: true, run, code: error.code ?? 'SECRETARY_FINAL_FAILED' };
      }
    })();
    const flight = { run, promise }; this.taskFlights.set(sessionId, flight);
    try { return await promise; }
    finally {
      if (this.taskFlights.get(sessionId) === flight) this.taskFlights.delete(sessionId);
      if (this.taskControllers.get(sessionId) === taskCtrl) this.taskControllers.delete(sessionId);
    }
  }

  async resumeCheckpoint(sessionId, parentAgent, { checkpointId, manualSpeechToken = null, secretaryModel = null } = {}) {
    const preview = await this.getResumePreview(sessionId, parentAgent);
    if (!preview.ok || checkpointId !== preview.checkpointId) throw checkpointError('CHECKPOINT_PREFLIGHT_FAILED', preview.missing.join('；') || '断点选择已过期');
    if (preview.kind === 'root-finalizing') return this.resumeFinalDelivery(this.runs.get(sessionId), parentAgent, preview, secretaryModel);
    if (secretaryModel) throw checkpointError('SECRETARY_MODEL_INVALID', '只有最终秘书收尾可以明确替换秘书模型');
    if (preview.manualSpeechOnly && !this.sessions.matchesManualSpeechResume(manualSpeechToken, preview.manualSpeechOnly)) throw checkpointError('CHECKPOINT_PREFLIGHT_FAILED', preview.missing.join('；'));
    const run = this.runs.get(sessionId), group = run.groups.find(g => g.key === preview.groupKey);
    const result = await this.sessions.withGroupLease(sessionId, group.key, run.taskId, async () => {
      const current = await this.getResumePreview(sessionId, parentAgent);
      if (!current.ok || current.checkpointId !== checkpointId) throw checkpointError('CHECKPOINT_PREFLIGHT_FAILED', current.missing.join('；') || '断点选择已过期');
      if (manualSpeechToken && !this.sessions.matchesManualSpeechResume(manualSpeechToken, current.manualSpeechOnly)
        || current.manualSpeechOnly && !manualSpeechToken) throw checkpointError('CHECKPOINT_PREFLIGHT_FAILED', '正文接续断点或确认已变化');
      const cp = await this.readResumeCheckpoint(run, group, parentAgent);
      run.stoppedAll = false; group.stopped = false; group.blocked = false;
      run.stage = cp.runStage ?? run.stage;
      run.round = cp.reviewRevision ?? run.round; run.error = null;
      run.rootPosition ??= {};
      const branch = String(cp.stageOptions.stageKey).startsWith('construction') ? 'construction' : 'design';
      run.rootPosition[branch + 'Attempt'] = cp.stageOptions.attempt;
      group.blockers = []; group.canResume = false;
      const result = await this._executeGroupStage(run, parentAgent, group, { ...cp.stageOptions, promptContext: cp.promptContext, restoredCheckpoint: cp, manualSpeechToken });
      run.stageLabel = result.stopped ? group.statusText : '本组讨论已接续完成';
      this.emit(sessionId);
      return { ...result, run };
    });
    if (!result.stopped) {
      await this.runTask(sessionId, parentAgent, '');
      return { ...result, run, stopped: Boolean(run.error || run.stoppedAll || run.groups.some(item => item.stopped)) };
    }
    return result;
  }

  emit(sessionId) {
    const run = this.runs.get(sessionId);
    if (run) this.persistGlobalInstructions(run);
    if (run && typeof this.onStateChange === 'function') { try { this.onStateChange(sessionId, run); } catch {} }
  }

  persistGroupState(run, group) {
    this.sessions.saveGroupProgress(run.sessionId, group.key, run.taskId, {
      stopped: group.stopped,
      stoppedAll: run.stoppedAll,
      reviewRevision: run.round,
      blocked: group.blocked ?? false,
      blockers: group.blockers ?? [],
      stageContexts: group.stageContexts ?? {},
      executionEpoch: group.executionEpoch ?? 0,
      handoffs: group.handoffs ?? {},
      formalText: group.formalText ?? null,
      formalVersion: group.formalVersion ?? null,
      handoffReceived: group.handoffReceived ?? false,
      blockedMeetingKey: group.blockedMeetingKey ?? null,
      lastSpeechFailure: group.lastSpeechFailure ?? null,
      discussionRound: group.discussionRound ?? null,
      runStage: run.stage,
      statusText: group.statusText,
      color: group.color,
      queue: run.queue.filter(instruction => instruction.groupKey === group.key)
    });
  }

  persistGlobalInstructions(run) {
    this.sessions.saveGroupProgress(run.sessionId, TASK_CONTROL_KEY, run.taskId, {
      queue: run.queue.filter(instruction => !instruction.groupKey),
      taskInputs: { userMessage: run.originalUserMessage ?? null, goal: run.taskGoalText ?? run.config.goal ?? '' },
      mainContextUsage: run.mainContextUsage ?? {},
      reviewRevision: run.round,
      rootProgress: {
        version: 1, configFingerprint: checkpointFingerprint(run.config),
        stage: run.stage, stageLabel: run.stageLabel, round: run.round,
        stoppedAll: run.stoppedAll, awaitingHumanApproval: Boolean(run.awaitingHumanApproval),
        humanApproved: Boolean(run.humanApproved), userAcceptanceStatus: run.userAcceptanceStatus,
        designArtifact: run.designArtifact ?? null, constructionArtifact: run.constructionArtifact ?? null,
        deliverables: run.deliverables ?? [], position: run.rootPosition ?? {},
        secretaryModelOverride: run.secretaryModelOverride ?? null,
        secretaryState: run.secretary ? { color: run.secretary.color, status: run.secretary.status ?? 'idle',
          error: run.secretary.error ?? null, latestBrief: run.secretary.latestBrief ?? '',
          reports: run.secretary.reports ?? [], reportSourceId: run.secretary.reportSourceId ?? null } : null,
        error: run.error ?? null
      },
      independentProgress: Object.fromEntries(run.independents.map(ind => [ind.key, {
        blocked: ind.blocked ?? false,
        executionEpoch: ind.executionEpoch ?? 0,
        blockedStageKey: ind.blockedStageKey ?? null,
        handoffs: ind.handoffs ?? {},
        formalOutputRef: ind.formalOutputRef ?? null,
        toolTurns: ind.toolTurns ?? {}
      }]))
    });
  }

  ensureRun(sessionId, config, workspaceRoot) {
    const validated = validateCabinetConfig(config, 'task');
    if (!validated.ok) {
      throw Object.assign(new Error(validated.errors[0]?.message || '任务配置不完整'), { code: validated.errors[0]?.code || 'INVALID_TASK', errors: validated.errors });
    }
    const normalized = structuredClone(validated.value);
    let run = this.runs.get(sessionId);
    if (run && run.taskId !== normalized.taskId) {
      this.taskControllers.get(sessionId)?.abort(new Error('TASK_REPLACED'));
      for (const [key, controller] of this.groupControllers) {
        if (key.startsWith(`${sessionId}::`)) controller.abort(new Error('TASK_REPLACED'));
      }
      run = null;
    }
    if (run && run.configVersion === normalized.configVersion) {
      if (checkpointFingerprint(run.config) !== checkpointFingerprint(normalized)
        || path.resolve(workspaceRoot || run.workspaceRoot) !== path.resolve(run.workspaceRoot)) {
        throw checkpointError('CHECKPOINT_CONTEXT_MISMATCH', '当前任务配置或工作区与运行记录不一致');
      }
      return run;
    }
    const existingRun = run;
    const taskControls = this.sessions.readGroupProgress?.(sessionId, TASK_CONTROL_KEY, normalized.taskId) ?? {};
    const rootProgress = taskControls.rootProgress;
    if (rootProgress && (rootProgress.version !== 1 || rootProgress.configFingerprint !== checkpointFingerprint(normalized))) {
      throw checkpointError('CHECKPOINT_CONTEXT_MISMATCH', '保存的任务流程与当前配置不一致');
    }
    const secretaryModelOverride = run?.secretaryModelOverride ?? rootProgress?.secretaryModelOverride ?? null;
    if (secretaryModelOverride && (typeof secretaryModelOverride.providerId !== 'string' || !secretaryModelOverride.providerId
      || typeof secretaryModelOverride.modelId !== 'string' || !secretaryModelOverride.modelId)) throw checkpointError('CHECKPOINT_CONTEXT_MISMATCH', '保存的秘书替换模型标识无效');
    const secretaryModel = secretaryModelOverride ?? normalized.secretary.model;
    const secretaryState = run?.secretary ?? rootProgress?.secretaryState;
    const legacySecretaryFailure = !secretaryState && rootProgress?.stage === 'finalizing-delivery' && rootProgress.error;
    const groupMap = new Map((run?.groups ?? []).map(g => [g.key, g]));

    const groups = validated.groups.map(g => {
      const prev = groupMap.get(g.key);
      const stored = this.sessions.readGroupProgress?.(sessionId, g.key, normalized.taskId) ?? {};
      const checkpoint = this.sessions.readGroupCheckpoint?.(sessionId, g.key, normalized.taskId);
      const binding = prev?.binding ?? this.sessions.findGroupConversation?.({ parentSessionId: sessionId, taskId: normalized.taskId, groupId: g.groupId, groupKey: g.key }) ?? null;
      return {
        ...g,
        round: prev?.round ?? checkpoint?.currentRound ?? stored.discussionRound ?? 1,
        discussionRound: prev?.discussionRound ?? checkpoint?.currentRound ?? stored.discussionRound ?? null,
        color: prev?.color ?? stored.color ?? 'neutral',
        statusText: prev?.statusText ?? stored.statusText ?? '等待前序阶段',
        stopped: prev?.stopped ?? stored.stopped ?? false,
        canResume: prev?.canResume ?? stored.stopped ?? false,
        reviewConclusion: prev?.reviewConclusion ?? null,
        formalText: prev?.formalText ?? stored.formalText ?? null,
        formalVersion: prev?.formalVersion ?? stored.formalVersion ?? null,
        handoffReceived: prev?.handoffReceived ?? stored.handoffReceived ?? false,
        materials: prev?.materials ?? [],
        files: prev?.files ?? [],
        binding,
        nativeSessionId: binding?.nativeSessionId ?? binding?.sessionId ?? null,
        blocked: prev?.blocked ?? stored.blocked ?? false,
        blockedMeetingKey: prev?.blockedMeetingKey ?? stored.blockedMeetingKey ?? null,
        lastSpeechFailure: prev?.lastSpeechFailure ?? stored.lastSpeechFailure ?? null,
        blockers: prev?.blockers ?? stored.blockers ?? [],
        stageContexts: prev?.stageContexts ?? stored.stageContexts ?? {},
        executionEpoch: prev?.executionEpoch ?? stored.executionEpoch ?? 0,
        handoffs: prev?.handoffs ?? stored.handoffs ?? {},
        pendingInstructions: stored.queue ?? [],
        persistedStoppedAll: stored.stoppedAll ?? false,
        persistedReviewRevision: stored.reviewRevision ?? 1,
        persistedRunStage: checkpoint?.runStage ?? stored.runStage ?? null,
        persistedFault: checkpoint?.fault ?? stored.lastSpeechFailure ?? null,
        members: g.participantIds.map(pid => {
          const seat = normalized.seats.find(s => s.id === pid);
          const duty = seat?.duties.find(d => d.role === g.role && (d.groupId || `${d.role}-group`) === g.groupId);
          const prevM = prev?.members?.find(m => m.id === pid);
          return {
            id: pid, label: seat?.label || pid, role: g.role, kind: duty?.kind || 'member',
            roleBadge: `${ROLE_LABELS[g.role]}${KIND_LABELS[duty?.kind || 'member']}`,
            model: seat?.model, statusText: prevM?.statusText ?? '待命', color: prevM?.color ?? 'neutral'
          };
        })
      };
    });

    const groupedSeatRoles = new Set();
    for (const g of validated.groups) for (const pid of g.participantIds) groupedSeatRoles.add(`${pid}::${g.role}`);

    const independents = [];
    for (const seat of normalized.seats.filter(s => s.inSeat)) {
      for (const duty of seat.duties) {
        if (duty.kind === 'independent' || !groupedSeatRoles.has(`${seat.id}::${duty.role}`)) {
          const prevInd = run?.independents?.find(i => i.id === seat.id && i.role === duty.role);
          const indKey = `ind::${seat.id}::${duty.role}`;
          const storedInd = taskControls.independentProgress?.[indKey] ?? {};
          independents.push({
            key: indKey, id: seat.id, label: `${ROLE_LABELS[duty.role]} · ${seat.label}`,
            blocked: prevInd?.blocked ?? storedInd.blocked ?? false,
            executionEpoch: prevInd?.executionEpoch ?? storedInd.executionEpoch ?? 0,
            blockedStageKey: prevInd?.blockedStageKey ?? storedInd.blockedStageKey ?? null,
            handoffs: prevInd?.handoffs ?? storedInd.handoffs ?? {},
            formalOutputRef: prevInd?.formalOutputRef ?? storedInd.formalOutputRef ?? null,
            toolTurns: prevInd?.toolTurns ?? structuredClone(storedInd.toolTurns ?? {}),
            seatLabel: seat.label, role: duty.role, reviewTargets: duty.reviewTargets ?? ['design', 'construction'],
            model: seat.model, color: prevInd?.color ?? 'neutral', statusText: prevInd?.statusText ?? '等待前序阶段',
            reviewConclusion: prevInd?.reviewConclusion ?? null, outputText: prevInd?.outputText ?? null
          });
        }
      }
    }

    run = {
      sessionId, runId: run?.runId ?? `run-${crypto.randomUUID().slice(0, 8)}`,
      taskId: normalized.taskId || sessionId, configVersion: normalized.configVersion, config: normalized,
      originalUserMessage: run?.originalUserMessage ?? taskControls.taskInputs?.userMessage ?? run?.lastTaskPrompt ?? null,
      taskGoalText: run?.taskGoalText ?? taskControls.taskInputs?.goal ?? normalized.goal,
      lastTaskPrompt: run?.lastTaskPrompt ?? taskControls.taskInputs?.userMessage ?? null,
      taskDiscussionRounds: run?.lastTaskPrompt ? run.taskDiscussionRounds : normalized.discussionRounds,
      mainContextUsage: mergeContextUsage(taskControls.mainContextUsage, run?.mainContextUsage),
      workspaceRoot: workspaceRoot || run?.workspaceRoot || process.cwd(),
      stage: run?.stage ?? rootProgress?.stage ?? groups.find(group => group.persistedRunStage)?.persistedRunStage ?? 'idle', stageLabel: run?.stageLabel ?? rootProgress?.stageLabel ?? '待命 · 输入任务后自动推进',
      round: run?.round ?? rootProgress?.round ?? Math.max(1, taskControls.reviewRevision ?? 1, ...groups.map(group => group.persistedReviewRevision)), stoppedAll: run?.stoppedAll ?? rootProgress?.stoppedAll ?? groups.some(group => group.persistedStoppedAll),
      awaitingHumanApproval: run?.awaitingHumanApproval ?? rootProgress?.awaitingHumanApproval ?? false,
      humanApproved: run?.humanApproved ?? rootProgress?.humanApproved ?? normalized.existingDesign?.approved === true,
      userAcceptanceStatus: run?.userAcceptanceStatus ?? rootProgress?.userAcceptanceStatus ?? 'pending',
      rootPosition: run?.rootPosition ?? structuredClone(rootProgress?.position ?? {}),
      secretaryModelOverride,
      groups, independents, subteams: run?.subteams ?? [],
      secretary: secretaryModel ? {
        model: secretaryModel,
        label: `秘书 · ${secretaryModel.shortLabel}`,
        color: secretaryState?.color ?? (legacySecretaryFailure ? 'red' : 'neutral'),
        status: secretaryState?.status ?? (legacySecretaryFailure ? 'failed' : 'idle'),
        error: secretaryState?.error ?? (legacySecretaryFailure || null),
        latestBrief: secretaryState?.latestBrief ?? (legacySecretaryFailure ? '' : '待任务启动后汇报进度。'),
        reportSourceId: secretaryState?.reportSourceId ?? null,
        reports: structuredClone(secretaryState?.reports ?? [])
      } : null,
      designArtifact: run?.designArtifact ?? rootProgress?.designArtifact ?? (normalized.existingDesign?.text ? { version: normalized.existingDesign.version || 'v1', text: normalized.existingDesign.text, approved: !!normalized.existingDesign.approved } : null),
      constructionArtifact: run?.constructionArtifact ?? rootProgress?.constructionArtifact ?? null,
      deliverables: run?.deliverables ?? rootProgress?.deliverables ?? [], originals: run?.originals ?? [],
      queue: run?.queue ?? [...new Map([...(taskControls.queue ?? []), ...groups.flatMap(group => group.pendingInstructions)].map(item => [item.id, item])).values()], activeActor: run?.activeActor ?? null,
      error: run?.error ?? rootProgress?.error ?? groups.find(group => group.persistedFault)?.persistedFault?.reason ?? null
    };
    if (existingRun) run = Object.assign(existingRun, run);
    this.runs.set(sessionId, run);
    return run;
  }

  stopGroup(sessionId, groupKey) {
    const run = this.runs.get(sessionId);
    if (!run) return null;
    const group = run.groups.find(g => g.key === groupKey || g.groupId === groupKey);
    if (!group) return run;
    const ctrlKey = `${sessionId}::${group.key}`;
    this.groupControllers.get(ctrlKey)?.abort(new Error('GROUP_STOPPED'));
    group.stopped = true;
    group.canResume = true;
    group.color = 'neutral';
    group.statusText = '本组已停止';
    for (const m of group.members) {
      if (m.color === 'yellow') { m.color = 'neutral'; m.statusText = '已停止'; }
    }
    this.persistGroupState(run, group);
    this.emit(sessionId);
    return run;
  }

  async resumeGroup() {
    throw checkpointError('CHECKPOINT_SELECTION_REQUIRED', '请打开内阁，明确选择「接续此任务」并通过预检');
  }

  stopAll(sessionId) {
    const run = this.runs.get(sessionId);
    if (!run) return null;
    this.taskControllers.get(sessionId)?.abort(new Error('TASK_STOPPED'));
    for (const [k, ctrl] of this.groupControllers.entries()) {
      if (k.startsWith(`${sessionId}::`)) {
        ctrl.abort(new Error('TASK_STOPPED'));
      }
    }
    run.stoppedAll = true;
    run.stageLabel = '全部工作已停止';
    for (const g of run.groups) {
      g.stopped = true;
      g.canResume = true;
      if (g.color === 'yellow') g.color = 'neutral';
      g.statusText = '已停止';
      for (const m of g.members) if (m.color === 'yellow') { m.color = 'neutral'; m.statusText = '已停止'; }
      this.persistGroupState(run, g);
    }
    for (const ind of run.independents) {
      if (ind.color === 'yellow') { ind.color = 'neutral'; ind.statusText = '已停止'; }
    }
    this.emit(sessionId);
    return run;
  }

  async resumeAll() {
    throw checkpointError('CHECKPOINT_SELECTION_REQUIRED', '请打开内阁，明确选择「接续此任务」并通过预检');
  }

  prepareResume() {
    throw checkpointError('CHECKPOINT_SELECTION_REQUIRED', '请打开内阁，明确选择「接续此任务」并通过预检');
  }

  enqueueInstruction(sessionId, { groupKey = null, selector = 'current', participantId = null, text = '' }) {
    const run = this.runs.get(sessionId);
    if (!run || !String(text || '').trim()) throw new Error('请输入补充指令内容');
    let targetSeat = null;
    if (participantId) {
      targetSeat = run.config.seats.find(s => s.id === participantId && s.inSeat);
    } else if (!groupKey && selector === 'current' && run.activeActor && !run.activeActor.groupKey) {
      targetSeat = run.config.seats.find(s => s.id === run.activeActor.id && s.inSeat);
    }
    if (groupKey && !run.groups.some(item => item.key === groupKey || item.groupId === groupKey)) throw new Error('找不到本工作组');
    if (!targetSeat && selector !== 'next' && !groupKey && !run.activeActor?.groupKey) {
      targetSeat = run.config.seats.find(s => s.inSeat) ?? run.config.seats[0];
    }
    const resolvedGroupKey = groupKey ? run.groups.find(item => item.key === groupKey || item.groupId === groupKey)?.key : selector === 'next' ? null : run.activeActor?.groupKey ?? null;
    const item = {
      id: `inst-${crypto.randomUUID().slice(0, 8)}`,
      at: new Date().toISOString(),
      groupKey: resolvedGroupKey,
      selector,
      targetId: targetSeat?.id ?? 'next',
      targetLabel: targetSeat ? `${targetSeat.label}` : '下一位发言参与者',
      configVersion: run.configVersion,
      status: 'queued',
      text: String(text).trim()
    };
    run.queue.push(item);
    if (resolvedGroupKey) this.persistGroupState(run, run.groups.find(group => group.key === resolvedGroupKey));
    else this.persistGlobalInstructions(run);
    this.emit(sessionId);
    return item;
  }

  consumeQueuedGuidance(run, actorId, groupKey = null) {
    const matched = run.queue.filter(q => q.status === 'queued'
      && (q.groupKey ? q.groupKey === groupKey : !groupKey || q.targetId === 'next')
      && (q.targetId === actorId || q.targetId === 'next'));
    return matched.map(q => q.text).join('\n');
  }

  async invokeActorWithTools({ run, seat, role, roleBadge, groupKey = null, groupLabel = null, stageTitle = '', userPrompt, allowWrite = false, signal, turnId = null, checkpointAttempt = null, discussionRound = null, phase = null, stageKey = null, nativeBinding = null, parentAgent = null, independentKey = null, mainHandoffId = null, speechOnly = false }) {
    const invocationIdentity = checkpointFingerprint([run.taskId, run.configVersion, run.config, run.workspaceRoot]);
    const assertActive = () => {
      signal?.throwIfAborted?.();
      if (run.stoppedAll || this.runs.get(run.sessionId) !== run) throw new Error('TASK_STOPPED');
      if (checkpointFingerprint([run.taskId, run.configVersion, run.config, run.workspaceRoot]) !== invocationIdentity) throw checkpointError('CHECKPOINT_STALE_ATTEMPT', '任务配置已改变，拒绝迟到结果');
      if (groupKey && run.groups.find(group => group.key === groupKey)?.stopped) throw new Error('GROUP_STOPPED');
    };
    assertActive();
    if (groupKey && turnId) {
      const group = run.groups.find(item => item.key === groupKey) || { key: groupKey, label: groupLabel };
      const existing = groupMessages(this.sessions, run, group).find(message => message.turnId === turnId || message.id === turnId);
      if (existing && (!speechOnly || String(existing.text ?? '').trim())) {
        if (nativeBinding) await this.sessions.commitGroupMessage(nativeBinding, existing);
        assertActive();
        for (const instruction of run.queue.filter(item => (existing.guidanceIds ?? []).includes(item.id))) {
          instruction.status = 'delivered';
          instruction.deliveredAt ??= new Date().toISOString();
        }
        this.persistGroupState(run, group);
        return { text: existing.text, toolRecords: existing.toolRecords ?? [], sourceId: existing.sourceId, turnId, duplicate: true };
      }
    }
    if (!groupKey && turnId) {
      const existing = this.sessions.readOriginal(stableId('orig', run.taskId, turnId));
      if (existing) {
        for (const instruction of run.queue.filter(item => (existing.guidanceIds ?? []).includes(item.id))) {
          instruction.status = 'delivered';
          instruction.deliveredAt ??= new Date().toISOString();
        }
        this.persistGlobalInstructions(run);
        return { text: existing.text, toolRecords: existing.toolRecords ?? [], sourceId: existing.sourceId, turnId, duplicate: true };
      }
    }
    if (groupKey) {
      const globalNext = run.queue.filter(item => item.status === 'queued' && !item.groupKey && item.targetId === 'next');
      if (globalNext.length) {
        for (const instruction of globalNext) instruction.groupKey = groupKey;
        // Save the claimed group first. Recovery merges by instruction ID, with
        // the bound copy winning if a crash leaves the global copy behind.
        this.persistGroupState(run, run.groups.find(group => group.key === groupKey));
        this.persistGlobalInstructions(run);
      }
    }
    const memCtx = this.memory.formatPromptContext({
      role,
      providerId: seat.model.providerId,
      modelId: seat.model.modelId,
      projectId: run.taskId
    });
    const guidance = this.consumeQueuedGuidance(run, seat.id, groupKey);
    let guidanceIds = run.queue.filter(item => item.status === 'queued'
      && (item.groupKey ? item.groupKey === groupKey : !groupKey)
      && (item.targetId === seat.id || item.targetId === 'next')).map(item => item.id);
    const systemPrompt = [
      `你是内阁中的「${seat.label}」，当前担任职责：${roleBadge}。`,
      memCtx.promptBlock
    ].filter(Boolean).join('\n\n');

    const independent = !groupKey && independentKey && turnId ? run.independents.find(item => item.key === independentKey) : null;
    let independentTurn = independent?.toolTurns?.[turnId];
    const independentIdentity = { turnId, stageKey, actorId: seat.id, configFingerprint: checkpointFingerprint(run.config) };
    if (independentTurn && Object.keys(independentIdentity).some(key => independentTurn[key] !== independentIdentity[key])) {
      throw checkpointError('CHECKPOINT_CONTEXT_MISMATCH', '独立席工具记录与当前阶段或席位不一致');
    }
    if (independentTurn?.toolReceipts?.some(receipt => receipt.status !== 'completed' && receipt.sideEffectRisk)) {
      throw checkpointError('CHECKPOINT_SIDE_EFFECT_UNCERTAIN', '独立席上次工具执行尚无可靠回执，不重复执行');
    }
    if (independent && !independentTurn) {
      independent.toolTurns ??= {};
      independentTurn = independent.toolTurns[turnId] = { ...independentIdentity, toolReceipts: [] };
    }
    const savedToolProgress = !speechOnly ? checkpointAttempt !== null
      ? this.sessions.readGroupCheckpoint(run.sessionId, groupKey, run.taskId)?.turns.find(turn => turn.turnId === turnId)?.toolContinuation
      : independentTurn?.toolContinuation : null;
    const toolRecords = structuredClone(savedToolProgress?.pendingBatch?.recordsBefore ?? savedToolProgress?.toolRecords ?? []);
    let finalText = '';
    const requiresVisibleSpeech = Boolean(groupKey) && ['opening', 'member', 'formal'].includes(phase);
    const speechDiagnostics = { modelCalls: 0, visibleTextChunks: 0, finalVisibleTextChunks: 0, finishReasons: [], calls: [] };
    const safeFinishReasons = new Set(['stop', 'tool-calls', 'max-tokens', 'aborted', 'error', 'unknown', 'missing']);
    const speechFailure = (code, reason) => {
      if (checkpointAttempt !== null) {
        const cp = this.sessions.readGroupCheckpoint(run.sessionId, groupKey, run.taskId);
        const turn = cp?.turns.find(item => item.turnId === turnId);
        if (turn?.attempt !== checkpointAttempt || cp.nextTurnId !== turnId) throw checkpointError('CHECKPOINT_STALE_ATTEMPT', '迟到响应不属于当前席位尝试');
      }
      const group = run.groups.find(item => item.key === groupKey);
      if (group) {
        // Bounded identities and outcomes only; do not persist tool arguments or output here.
        group.lastSpeechFailure = { code, taskId: run.taskId, actorId: seat.id, actorLabel: seat.label,
          groupKey, turnId, stageKey, phase, discussionRound, at: new Date().toISOString(), reason,
          ...speechDiagnostics, toolRecordCount: toolRecords.length };
        this.persistGroupState(run, group);
      }
      return Object.assign(new Error(reason), { code });
    };
    let mainReadScope = null;
    let mainContextReceipt = null;
    let mainBriefCharged = false;
    let mainReadAttempts = 0;
    let mainReadControlBytes = 0;
    let mainReadLimitNotified = false;
    const usageBefore = JSON.stringify(run.mainContextUsage ?? {});

    run.activeActor = { id: seat.id, label: seat.label, role, groupKey, turnId };
    this.emit(run.sessionId);
    try {
    mainReadScope = this.mainContext.begin({
      parentAgent, run, seat, role, groupKey, phase, stageKey, turnId,
      independentKey, signal, isCurrent: () => this.runs.get(run.sessionId) === run,
      onUsage: () => this.persistGlobalInstructions(run)
    });
    const cachedBrief = checkpointAttempt !== null
      ? this.sessions.readGroupCheckpoint(run.sessionId, groupKey, run.taskId)?.turns.find(t => t.turnId === turnId)?.mainBriefCache
      : independentTurn?.mainBriefCache;
    const mainBrief = cachedBrief ? cachedBrief.text : this.mainContext.canRead(mainReadScope) ? this.mainContext.brief(mainReadScope) : '';
    mainBriefCharged = Boolean(mainBrief) && !cachedBrief;
    if (checkpointAttempt !== null && mainBrief && !cachedBrief) {
      this.sessions.updateGroupCheckpoint(run.sessionId, groupKey, run.taskId, cp => {
        cp.turns.find(t => t.turnId === turnId).mainBriefCache = { text: mainBrief, receipt: mainContextReceipt };
      });
    } else if (independentTurn && mainBrief && !cachedBrief) {
      independentTurn.mainBriefCache = { text: mainBrief, receipt: mainContextReceipt };
      this.persistGlobalInstructions(run);
    }
    const fullUserPrompt = [taskTurnContext(this.sessions, run, { seat, role, roleBadge, groupKey, independentKey, stageTitle, stageKey, phase, discussionRound }),
      userPrompt, guidance ? `【用户补充指令】\n${guidance}` : '',
      mainBrief ? `【本主对话有限前情 · 按消息标识追溯】\n${mainBrief}` : '',
      speechOnly ? '【手动正文接续】上一尝试的工具影响仍未核实。本次不提供、不执行任何工具，不得重放或把上次未核实的操作说成已完成。仅依据原任务和前文完成本棒正文。必须返回 JSON：{"ready":true,"text":"最终正文","blockers":[]}；若仍需要工具或不能完成，返回 ready:false、text:"" 并在 blockers 列明原因。text 必须保持原任务要求的正文格式；原格式若为 JSON，也应作为字符串放入 text。' : ''].filter(Boolean).join('\n\n');
    const tools = speechOnly ? [] : this.sessions.toolsForRole(role, { allowWrite, agent: parentAgent, mainContext: this.mainContext, mainReadScope });
    const allowedTools = new Set(tools.map(tool => tool.name));
    let messages = structuredClone(savedToolProgress?.messages ?? null);
    let pendingBatch = structuredClone(savedToolProgress?.pendingBatch ?? null);
    let carriedGuidanceIds = savedToolProgress ? [...(savedToolProgress.carriedGuidanceIds ?? [])] : [...guidanceIds];
    const saveToolProgress = nextStep => {
      if (!speechOnly && (checkpointAttempt !== null || independentTurn)) {
        const progress = { nextStep, messages, toolRecords, pendingBatch, carriedGuidanceIds };
        try {
          if (checkpointAttempt !== null) this.sessions.saveGroupToolProgress(run.sessionId, groupKey, run.taskId, turnId, checkpointAttempt, progress);
          else { independentTurn.toolContinuation = structuredClone(progress); this.persistGlobalInstructions(run); }
        }
        catch (error) { throw Object.assign(new Error('工具续接记录未能保存，已停止执行', { cause: error }), { code: 'CABINET_TOOL_RECEIPT_WRITE_FAILED' }); }
      }
    };
    for (let step = pendingBatch?.step ?? savedToolProgress?.nextStep ?? 0; step < 3; step++) {
      assertActive();
      if (!pendingBatch && messages) {
        const addedGuidance = run.queue.filter(item => guidanceIds.includes(item.id) && !carriedGuidanceIds.includes(item.id));
        if (addedGuidance.length) {
          messages.push({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text',
            text: `【用户补充指令】\n${addedGuidance.map(item => item.text).join('\n')}` }] });
          carriedGuidanceIds.push(...addedGuidance.map(item => item.id));
        }
      }
      const finalResponse = step === 2;
      if (finalResponse && !pendingBatch) messages = [...messages, { role: 'user', source: { kind: 'user' }, content: [{ type: 'text',
        text: '本棒工具调用阶段已结束。请按原任务要求和原有输出格式，根据前文及已经返回的工具结果，直接给出本棒最终可见正文；本次不提供新工具。若证据不足，请明确指出缺失信息和限制，不要把未完成的操作写成已完成。' }] }];
      const replayedToolBatch = Boolean(pendingBatch);
      const resp = pendingBatch?.response ?? await this.llm.invokeModel({
        modelRef: seat.model,
        systemPrompt,
        userPrompt: fullUserPrompt,
        messages,
        tools: finalResponse ? [] : tools,
        sessionId: run.sessionId,
        signal
      });
      assertActive();
      if (checkpointAttempt !== null) {
        const cp = this.sessions.readGroupCheckpoint(run.sessionId, groupKey, run.taskId);
        if (cp?.nextTurnId !== turnId || cp.turns.find(item => item.turnId === turnId)?.attempt !== checkpointAttempt) throw checkpointError('CHECKPOINT_STALE_ATTEMPT', '迟到响应不属于当前席位尝试');
      }
      if (!replayedToolBatch) speechDiagnostics.modelCalls += 1;
      const visibleChunks = resp.diagnostics?.visibleTextChunks;
      speechDiagnostics.finalVisibleTextChunks = Number.isSafeInteger(visibleChunks) && visibleChunks >= 0
        ? visibleChunks : typeof resp.text === 'string' && resp.text.trim() ? 1 : 0;
      speechDiagnostics.visibleTextChunks += speechDiagnostics.finalVisibleTextChunks;
      const finishes = Array.isArray(resp.diagnostics?.finishReasons) ? resp.diagnostics.finishReasons : ['missing'];
      speechDiagnostics.finishReasons.push(...finishes.slice(0, 7).map(reason => safeFinishReasons.has(reason) ? reason : 'unknown'));
      const callEvidence = { call: step + 1, finalResponse, replayedToolBatch, visibleTextChunks: speechDiagnostics.finalVisibleTextChunks,
        finishReasons: finishes.slice(0, 7).map(reason => safeFinishReasons.has(reason) ? reason : 'unknown'),
        toolCallCount: resp.toolCalls?.length ?? 0,
        toolCalls: (resp.toolCalls ?? []).slice(0, 16).map(call => ({ id: String(call.id).slice(0, 256), name: String(call.name).slice(0, 128) })),
        toolResults: [], inputToolResults: (resp.messages ?? []).filter(message => message.role === 'tool').slice(-16)
          .map(message => ({ id: String(message.toolCallId).slice(0, 256), isError: Boolean(message.isError) })) };
      speechDiagnostics.calls.push(callEvidence);
      if (speechOnly) {
        const completion = extractFormalDecision(resp.text);
        if (resp.toolCalls?.length || !finishes.length || finishes.some(reason => reason !== 'stop') || !completion.ready) {
          throw speechFailure('CABINET_SPEECH_ONLY_BLOCKED',
            `席位「${seat.label}」正文接续未完成；未执行工具、未提交发言、未交给下一席`);
        }
        finalText = completion.text;
        break;
      }
      if (requiresVisibleSpeech) finalText = typeof resp.text === 'string' ? resp.text : '';
      else if (resp.text) finalText = resp.text;
      if (!resp.toolCalls || resp.toolCalls.length === 0) break;
      if (finalResponse) throw speechFailure('CABINET_TOOL_BUDGET_EXHAUSTED',
        `席位「${seat.label}」已用尽本棒 3 次模型请求，最终答复仍要求新工具；未执行这些工具、未提交发言、未交给下一席`);

      pendingBatch ??= { step, response: structuredClone(resp), recordsBefore: structuredClone(toolRecords) };
      messages = [...resp.messages, resp.assistantMessage];
      saveToolProgress(step);
      let currentToolReceipt = null;
      let currentToolRecordStart = toolRecords.length;
      const appendToolResult = (callId, output, isError, content) => {
        if (callEvidence.toolResults.length < 16) callEvidence.toolResults.push({ id: String(callId).slice(0, 256), isError: Boolean(isError) });
        const message = {
        id: `cab-tool-${crypto.randomUUID()}`, role: 'tool', toolCallId: callId, isError,
        content: Array.isArray(content) ? structuredClone(content)
          : [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output ?? '') }],
        source: { kind: 'tool', callId }
        };
        if (currentToolReceipt) {
          const record = toolRecords.length > currentToolRecordStart ? toolRecords.at(-1)
            : { id: callId, name: currentToolReceipt.name, status: isError ? '失败' : '已完成', output };
          try {
            if (checkpointAttempt !== null) this.sessions.finishGroupToolCall(run.sessionId, groupKey, run.taskId, turnId, checkpointAttempt, callId, message, record);
            else {
              Object.assign(currentToolReceipt, { status: 'completed', completedAt: new Date().toISOString(),
                message: structuredClone(message), record: structuredClone(record) });
              this.persistGlobalInstructions(run);
            }
          }
          catch (error) { throw Object.assign(new Error('工具执行结果未能保存，已停止执行', { cause: error }), { code: 'CABINET_TOOL_RECEIPT_WRITE_FAILED' }); }
        }
        messages.push(message);
        saveToolProgress(step);
      };
      for (const tc of resp.toolCalls) {
        assertActive();
        currentToolRecordStart = toolRecords.length;
        const sideEffectRisk = allowedTools.has(tc.name) && !['list_files', 'read_file', 'search_text', MAIN_CONTEXT_TOOL.name].includes(tc.name);
        currentToolReceipt = checkpointAttempt !== null ? this.sessions.beginGroupToolCall(run.sessionId, groupKey, run.taskId, turnId,
          checkpointAttempt, tc, sideEffectRisk) : null;
        if (independentTurn) {
          currentToolReceipt = independentTurn.toolReceipts.find(receipt => receipt.id === tc.id);
          if (currentToolReceipt) {
            if (currentToolReceipt.name !== tc.name || JSON.stringify(currentToolReceipt.arguments) !== JSON.stringify(tc.arguments)) {
              throw checkpointError('CABINET_TOOL_CALL_CONFLICT', '同一独立席工具调用 ID 对应不同参数');
            }
            if (currentToolReceipt.status !== 'completed' && currentToolReceipt.sideEffectRisk) {
              throw checkpointError('CHECKPOINT_SIDE_EFFECT_UNCERTAIN', '独立席上次工具执行尚无可靠回执，不重复执行');
            }
          } else {
            currentToolReceipt = { id: tc.id, name: tc.name, arguments: structuredClone(tc.arguments), sideEffectRisk,
              status: 'started', startedAt: new Date().toISOString() };
            independentTurn.toolReceipts.push(currentToolReceipt);
            this.persistGlobalInstructions(run);
          }
        }
        if (currentToolReceipt?.status === 'completed') {
          if (currentToolReceipt.record) toolRecords.push(structuredClone(currentToolReceipt.record));
          messages.push(structuredClone(currentToolReceipt.message));
          saveToolProgress(step);
          continue;
        }
        if (tc.name === MAIN_CONTEXT_TOOL.name) {
          const control = (message, id) => {
            const feedback = `工具 ${MAIN_CONTEXT_TOOL.name}：${message}`;
            const record = { id, name: MAIN_CONTEXT_TOOL.name, path: '', status: '失败', output: message };
            const size = Buffer.byteLength(feedback, 'utf8') + Buffer.byteLength(JSON.stringify(record), 'utf8');
            if (mainReadControlBytes + size <= 1024) {
              mainReadControlBytes += size;
              toolRecords.push(record);
            }
            appendToolResult(tc.id, feedback, true);
          };
          if (mainReadAttempts >= 3) {
            if (!mainReadLimitNotified) {
              mainReadLimitNotified = true;
              control('本棒读取请求已达上限。', 'cabinet-main-read-limit');
            } else appendToolResult(tc.id, `工具 ${MAIN_CONTEXT_TOOL.name}：本棒读取请求已达上限。`, true);
            continue;
          }
          mainReadAttempts += 1;
          try {
            const out = await this.sessions.executeToolCall(tc, {
              workspaceRoot: run.workspaceRoot, role, allowWrite, signal,
              mainContext: this.mainContext, mainReadScope, allowedTools
            });
            assertActive();
            toolRecords.push({ id: `cabinet-main-read-${mainReadAttempts}`, name: MAIN_CONTEXT_TOOL.name,
              path: '', status: '已完成', output: out.output });
            appendToolResult(tc.id, out.output, false);
          } catch (error) {
            assertActive();
            if (typeof error?.code === 'string' && (error.code.startsWith('CHECKPOINT_') || error.code.startsWith('CABINET_TOOL_RECEIPT'))) throw error;
            control('本次读取请求被拒绝。', `cabinet-main-read-error-${mainReadAttempts}`);
          }
          continue;
        }
        try {
          const out = await this.sessions.executeToolCall(tc, {
            workspaceRoot: run.workspaceRoot,
            role,
            allowWrite,
            agent: parentAgent,
            signal,
            mainContext: this.mainContext,
            mainReadScope,
            allowedTools
          });
          assertActive();
          toolRecords.push({ id: tc.id, name: tc.name, path: out.path, fullPath: out.fullPath ?? null, status: out.isError ? '失败' : '已完成', output: out.output });
          appendToolResult(tc.id, out.output, Boolean(out.isError), out.content);
        } catch (err) {
          assertActive();
          if (typeof err?.code === 'string' && (err.code.startsWith('CHECKPOINT_') || err.code.startsWith('CABINET_TOOL_RECEIPT'))) throw err;
          const errMsg = err?.message || String(err);
          toolRecords.push({ id: tc.id, name: tc.name, path: tc.arguments?.path || '.', status: '失败', output: errMsg });
          appendToolResult(tc.id, errMsg, true);
        }
      }
      pendingBatch = null;
      saveToolProgress(step + 1);
    }

    assertActive();
    if (requiresVisibleSpeech
      && (typeof finalText !== 'string' || !finalText.trim())) {
      const reason = `席位「${seat.label}」本棒未返回非空可见正文，未提交发言、未交给下一席`;
      throw speechFailure('CABINET_EMPTY_VISIBLE_BODY', reason);
    }
    guidanceIds = carriedGuidanceIds;
    const originalPayload = {
      ...(turnId ? { sourceId: stableId('orig', run.taskId, turnId) } : {}),
      kind: groupKey ? 'group-turn' : 'independent-turn',
      taskId: run.taskId,
      turnId,
      discussionRound,
      phase,
      stageKey,
      guidanceIds,
      mainContextReceipt,
      groupKey,
      actorId: seat.id,
      actorLabel: seat.label,
      role,
      roleBadge,
      providerId: seat.model.providerId,
      modelId: seat.model.modelId,
      text: finalText,
      toolRecords,
      ...(speechOnly ? { manualSpeechOnly: true, priorToolEffects: 'unverified' } : {})
    };
    const checkpointEntry = {
      ...originalPayload, id: turnId, sourceId: originalPayload.sourceId,
      sessionId: run.sessionId, stageTitle, roleLabel: roleBadge,
      round: discussionRound || 1
    };
    if (checkpointAttempt !== null) {
      this.sessions.saveGroupTurnResult(run.sessionId, groupKey, run.taskId, turnId, checkpointEntry, { attempt: checkpointAttempt });
    }
    const orig = this.sessions.saveOriginal(run.sessionId, originalPayload);
    if (!run.originals.some(item => item.sourceId === orig.sourceId)) run.originals.push(orig);

    if (groupKey && checkpointAttempt !== null) {
      assertActive();
      await this.sessions.completeGroupTurn(nativeBinding, turnId);
      assertActive();
    } else if (groupKey) {
      const entry = this.sessions.appendGroupMessage(run.sessionId, groupKey, groupLabel, discussionRound || 1, {
        ...(turnId ? { id: turnId, turnId } : {}),
        taskId: run.taskId,
        discussionRound,
        phase,
        stageKey,
        guidanceIds,
        mainContextReceipt,
        stageTitle,
        actorId: seat.id,
        actorLabel: seat.label,
        roleLabel: roleBadge,
        providerId: seat.model.providerId,
        modelId: seat.model.modelId,
        text: finalText,
        toolRecords,
        sourceId: orig.sourceId
      });
      assertActive();
      if (nativeBinding) await this.sessions.commitGroupMessage(nativeBinding, entry);
      assertActive();
    }
    for (const instruction of run.queue.filter(item => guidanceIds.includes(item.id))) {
      instruction.status = 'delivered';
      instruction.deliveredAt = new Date().toISOString();
    }
    if (groupKey) this.persistGroupState(run, run.groups.find(group => group.key === groupKey));
    else this.persistGlobalInstructions(run);
    this.emit(run.sessionId);
    return { text: finalText, toolRecords, sourceId: orig.sourceId, turnId, mainContextReceipt };
    } catch (err) {
      if (mainBriefCharged || JSON.stringify(run.mainContextUsage ?? {}) !== usageBefore) {
        let committed = false;
        try {
          committed = groupKey
            ? groupMessages(this.sessions, run, run.groups.find(group => group.key === groupKey))
              .some(message => message.turnId === turnId || message.id === turnId)
            : Boolean(this.sessions.readOriginal(stableId('orig', run.taskId, turnId)));
        } catch {}
        if (!committed && err && typeof err === 'object') err.mainContextUncommittedBrief = true;
      }
      throw err;
    } finally {
      this.mainContext.close(mainReadScope);
      if (run.activeActor?.turnId === turnId && run.activeActor?.id === seat.id) run.activeActor = null;
    }
  }

  async runSecretaryReport(run, parentAgent, { kind = 'stage', stageSummary = '', details = '' }) {
    const secModel = run.secretaryModelOverride ?? run.config.secretary?.model;
    if (!secModel || !run.secretary || run.stoppedAll) return;
    const signal = this.taskControllers.get(run.sessionId)?.signal;
    const memCtx = this.memory.formatPromptContext({
      role: 'secretary',
      providerId: secModel.providerId,
      modelId: secModel.modelId,
      projectId: run.taskId
    });
    run.secretary.color = 'yellow'; run.secretary.status = 'running'; run.secretary.error = null;
    run.secretary.model = secModel; run.secretary.label = `秘书 · ${secModel.shortLabel}`;
    this.emit(run.sessionId);

    try {
      const reportSourceId = stableId('orig-secretary', run.sessionId, run.taskId,
        run.round, kind, stageSummary, details);
      const savedReport = this.sessions.readOriginal(reportSourceId);
      if (savedReport && (savedReport.taskId !== run.taskId || savedReport.sessionId !== run.sessionId
        || savedReport.actorId !== 'secretary' || savedReport.kind !== (kind === 'final' ? 'secretary-final' : 'secretary-stage')
        || typeof savedReport.text !== 'string' || !savedReport.text.trim())) throw checkpointError('SECRETARY_RESULT_INVALID', '已保存的秘书原稿归属或正文无效');
      const resp = savedReport ? { text: savedReport.text } : await this.llm.invokeModel({
        modelRef: secModel,
        preserveModelIdentity: true,
        systemPrompt: `你是内阁秘书（${secModel.shortLabel}）。只做简明中文阶段汇报或最终总结，不改写或截断原成果。\n${memCtx.promptBlock}`,
        userPrompt: `【汇报类型】${kind === 'final' ? '全部工作结束后的最终简短总结' : '阶段进度汇报'}\n【当前进展】${stageSummary}\n【成果摘要】\n${details.slice(0, 4000)}`,
        tools: [],
        sessionId: run.sessionId,
        signal
      });
      signal?.throwIfAborted?.();
      if (run.stoppedAll || this.runs.get(run.sessionId) !== run) return;
      const brief = typeof resp.text === 'string' ? resp.text.trim() : '';
      if (!brief || resp.toolCalls?.length) throw checkpointError('SECRETARY_EMPTY_VISIBLE_BODY', '秘书未返回有效的非空总结正文，尚未完成交付');
      const orig = savedReport ?? this.sessions.saveOriginal(run.sessionId, {
        sourceId: reportSourceId,
        kind: kind === 'final' ? 'secretary-final' : 'secretary-stage',
        taskId: run.taskId,
        actorId: 'secretary',
        actorLabel: run.secretary.label,
        role: 'secretary',
        providerId: secModel.providerId,
        modelId: secModel.modelId,
        text: brief,
        responseEvidence: { visibleText: true, finishReasons: resp.diagnostics?.finishReasons ?? [] }
      });
      if (!run.originals.some(item => item.sourceId === orig.sourceId)) run.originals.push(orig);
      run.secretary.latestBrief = brief.split(/\r?\n/)[0].slice(0, 120) || stageSummary;
      run.secretary.reportSourceId = orig.sourceId;
      if (!run.secretary.reports.some(report => report.id === orig.sourceId)) run.secretary.reports.push({
        id: orig.sourceId,
        kind,
        at: new Date().toISOString(),
        text: brief,
        sourceId: orig.sourceId
      });
      if (kind === 'final') {
        if (!parentAgent) throw checkpointError('MAIN_HANDOFF_UNAVAILABLE', '秘书正文已保存，主对话暂不可写');
        await this.sessions.appendMainAssistantMessage(parentAgent, {
          messageId: stableId('cab-secretary', reportSourceId),
          taskId: run.taskId,
          actorLabel: run.secretary.label,
          groupLabel: '秘书',
          title: `秘书 · ${secModel.shortLabel}`,
          role: 'secretary',
          participantId: 'secretary',
          providerId: secModel.providerId,
          modelId: secModel.modelId,
          phase: 'secretary-final',
          text: brief,
          sourceId: orig.sourceId
        });
      }
      run.secretary.color = 'green'; run.secretary.status = 'completed'; run.secretary.error = null;
    } catch (error) {
      run.secretary.latestBrief = '';
      run.secretary.color = 'red'; run.secretary.status = 'failed'; run.secretary.error = error.message;
      this.emit(run.sessionId);
      if (kind === 'final') throw error;
    }
    this.emit(run.sessionId);
  }

  async executeGroupStage(run, parentAgent, group, { stageTitle, promptContext, allowWrite = false, isReview = false, taskSignal, stageKey = null, attempt = 1 }) {
    return this.sessions.withGroupLease(run.sessionId, group.key, run.taskId, () =>
      this._executeGroupStage(run, parentAgent, group, { stageTitle, promptContext, allowWrite, isReview, taskSignal, stageKey, attempt }));
  }

  async _executeGroupStage(run, parentAgent, group, { stageTitle, promptContext, allowWrite = false, isReview = false, taskSignal, stageKey = null, attempt = 1, restoredCheckpoint = null, manualSpeechToken = null }) {
    if (group.stopped || run.stoppedAll) return { stopped: true };
    const rounds = resolveDiscussionRounds({ discussionRounds: run.taskDiscussionRounds ?? run.config.discussionRounds });
    const meetingKey = restoredCheckpoint?.meetingKey ?? `${stageKey || stageTitle}:attempt-${attempt}:revision-${run.round}:meeting-${group.executionEpoch ?? 0}`;
    const handoffId = stableId('cab-handoff', run.sessionId, run.taskId, group.key, meetingKey);
    const savedThread = this.sessions.readGroupThread(run.sessionId, group.key, group.label, run.taskId);
    const delivered = [savedThread.checkpoint, ...(savedThread.checkpointHistory ?? [])]
      .find(cp => cp?.meetingKey === meetingKey && cp.status === 'completed' && cp.configFingerprint === checkpointFingerprint(run.config));
    if (delivered) {
      const formal = delivered.turns.find(turn => turn.phase === 'formal');
      const decision = extractFormalDecision(formal?.entry?.text);
      if (decision.ready && existingFormalRelay(parentAgent, handoffId, run.taskId, decision.text)) {
        const binding = group.binding ?? this.sessions.findGroupConversation({ parentSessionId: run.sessionId,
          taskId: run.taskId, groupId: group.groupId, groupKey: group.key });
        if (savedThread.checkpoint?.meetingId === delivered.meetingId) await this.sessions.reconcileGroupCheckpoint(binding);
        else {
          const snapshot = await this.sessions.ctx.sessionQuery.readSession(binding.childSessionId);
          for (const turn of delivered.turns.filter(item => item.state === 'completed')) {
            const event = snapshot.events.find(item => item.type === 'plugin:cabinet-v2/speech' && item.data?.entry?.turnId === turn.turnId);
            if (!event) throw checkpointError('CHECKPOINT_RESULT_MISSING', '已交付的前序阶段缺少原生发言');
            this.sessions.validateGroupSpeech(binding, event, turn, delivered);
          }
        }
        return { stopped: false, text: decision.text, version: `${group.role}-v${attempt}`,
          sourceId: formal.entry.sourceId, handoffId, duplicate: true };
      }
    }
    const ctrlKey = `${run.sessionId}::${group.key}`;
    if (this.groupControllers.has(ctrlKey)) throw new Error('本组正在讨论，请等待当前一席提交');
    const groupCtrl = new AbortController();
    const onTaskAbort = () => groupCtrl.abort(new Error('TASK_STOPPED'));
    taskSignal?.addEventListener('abort', onTaskAbort, { once: true });
    this.groupControllers.set(ctrlKey, groupCtrl);

    const leaderSeat = run.config.seats.find(s => s.id === group.leaderId);
    const memberSeats = group.memberIds.map(id => run.config.seats.find(s => s.id === id)).filter(Boolean);
    const assertActive = () => {
      taskSignal?.throwIfAborted?.();
      groupCtrl.signal.throwIfAborted();
      if (group.stopped || run.stoppedAll || this.runs.get(run.sessionId) !== run) throw new Error('GROUP_STOPPED');
    };

    try {
      assertActive();
      const taskInputs = { userMessage: run.originalUserMessage ?? run.lastTaskPrompt, goal: run.taskGoalText ?? run.config.goal };
      const previousCheckpoint = this.sessions.readGroupCheckpoint(run.sessionId, group.key, run.taskId);
      const meetingId = previousCheckpoint?.meetingKey === meetingKey ? previousCheckpoint.meetingId : restoredCheckpoint?.meetingId ?? crypto.randomUUID();
      const specs = [{ actorId: leaderSeat.id, phase: 'opening', discussionRound: 0 },
        ...Array.from({ length: rounds }, (_, index) => memberSeats.map(seat => ({ actorId: seat.id, phase: 'member', discussionRound: index + 1 }))).flat(),
        { actorId: leaderSeat.id, phase: 'formal', discussionRound: 0 }];
      if (!previousCheckpoint && !restoredCheckpoint && (groupMessages(this.sessions, run, group).length || group.lastSpeechFailure)) {
        throw checkpointError('CHECKPOINT_SELECTION_REQUIRED', '已有讨论进度，请核对后确认接续此任务');
      }
      this.persistGlobalInstructions(run);
      const checkpoint = this.sessions.ensureGroupCheckpoint(run.sessionId, group.key, run.taskId, {
        meetingId, meetingKey, workspaceRoot: path.resolve(run.workspaceRoot),
        configFingerprint: checkpointFingerprint(run.config),
        inputFingerprint: checkpointFingerprint({ taskInputs, promptContext: String(promptContext ?? '') }),
        taskConfig: run.config, taskInputs, promptContext: String(promptContext ?? ''),
        runStage: run.stage, reviewRevision: run.round,
        stageOptions: { stageTitle, stageKey, attempt, allowWrite, isReview, rounds },
        seatOrder: [leaderSeat.id, ...memberSeats.map(seat => seat.id)],
        fault: restoredCheckpoint?.fault ?? null,
        failureEvidence: restoredCheckpoint?.failureEvidence ?? null,
        turns: previousCheckpoint?.meetingKey === meetingKey ? previousCheckpoint.turns : restoredCheckpoint?.turns ?? specs.map(spec => {
          const turnId = stableId('cab-turn', run.sessionId, run.taskId, group.key, meetingId, spec.phase, spec.discussionRound, spec.actorId);
          return { ...spec, turnId, sourceId: stableId('orig', run.taskId, turnId) };
        })
      });
      group.activeMeetingKey = checkpoint.meetingKey;
      group.binding = await this.sessions.ensureGroupConversation({
        parentSessionId: run.sessionId, taskId: run.taskId,
        groupId: group.groupId, groupKey: group.key, groupLabel: group.label,
        workspaceRoot: run.workspaceRoot
      });
      group.nativeSessionId = group.binding.nativeSessionId ?? group.binding.sessionId;
      assertActive();
      await this.sessions.reconcileGroupCheckpoint(group.binding);
      const storedProgress = this.sessions.readGroupProgress(run.sessionId, group.key, run.taskId);
      for (const item of storedProgress.queue ?? []) {
        const current = run.queue.find(q => q.id === item.id);
        if (current) Object.assign(current, item); else run.queue.push(item);
      }
      group.stageContexts ??= {};
      group.stageContexts[meetingKey] = checkpoint.promptContext;
      this.persistGroupState(run, group);
      const sourceContext = group.stageContexts[meetingKey];
      const invoke = async (seat, phase, discussionRound, userPrompt, canWrite = allowWrite) => {
        const cp = this.sessions.readGroupCheckpoint(run.sessionId, group.key, run.taskId);
        const turn = cp.turns.find(t => t.actorId === seat.id && t.phase === phase && t.discussionRound === discussionRound);
        if (!turn) throw checkpointError('CHECKPOINT_TURN_MISSING', '原讨论逻辑棒次缺失');
        if (turn.state === 'completed' || turn.state === 'skipped') return { ...turn.entry, duplicate: true, skipped: turn.state === 'skipped' };
        if (cp.nextTurnId !== turn.turnId) throw checkpointError('CHECKPOINT_NEXT_CONFLICT', '无法确定唯一下一席');
        const claim = this.sessions.claimGroupTurn(run.sessionId, group.key, run.taskId, turn.turnId, { manualSpeechToken });
        try { const result = await this.invokeActorWithTools({
        run, seat, role: group.role,
        roleBadge: `${ROLE_LABELS[group.role]}${phase === 'member' ? '组员' : '组长'}`,
        groupKey: group.key, groupLabel: group.label, stageTitle,
        userPrompt, allowWrite: canWrite, signal: groupCtrl.signal,
        turnId: turn.turnId, checkpointAttempt: claim.attempt, discussionRound,
        speechOnly: claim.manualSpeechOnlyAttempt === claim.attempt,
        phase, stageKey: meetingKey, nativeBinding: group.binding, parentAgent,
        mainHandoffId: phase === 'formal' ? handoffId : null
        });
          if (group.lastSpeechFailure?.actorId === seat.id && group.lastSpeechFailure?.phase === phase
            && group.lastSpeechFailure?.discussionRound === discussionRound) {
            group.lastSpeechFailure = null; this.persistGroupState(run, group);
          }
          return result;
        } catch (error) {
          this.sessions.recordGroupTurnFailure(run.sessionId, group.key, run.taskId, turn.turnId, { code: error.code ?? 'TURN_FAILED', reason: error.message, attempt: claim.attempt });
          throw error;
        }
      };
      group.color = 'yellow';
      group.statusText = '组长开场中';
      this.emit(run.sessionId);

      await invoke(leaderSeat, 'opening', 0,
        `【当前阶段：${stageTitle}】\n${sourceContext}\n\n【此前本组已提交讨论】\n${discussionContext(this.sessions, run, group)}\n\n请忠实带入以上用户原始需求或上一组正式成果，不遗漏限制。作为${group.label}组长开场，向${memberSeats.map(member => member.label).join('、')}拆分任务。本次讨论 ${rounds} 轮，每轮每名组员依次发言一次；开场和最后定稿不计轮数。`, false);
      assertActive();

      for (let round = 1; round <= rounds; round++) {
      group.discussionRound = round;
      for (const mSeat of memberSeats) {
        if (group.stopped || run.stoppedAll) return { stopped: true };
        const mInfo = group.members.find(m => m.id === mSeat.id);
        if (mInfo) { mInfo.color = 'yellow'; mInfo.statusText = '执行实务中'; }
        group.statusText = `第 ${round}/${rounds} 轮 · ${mSeat.label}`;
        this.emit(run.sessionId);

        await invoke(mSeat, 'member', round,
          `【当前阶段：${stageTitle}】\n${sourceContext}\n\n【本组开场与截至当前已提交的完整讨论】\n${discussionContext(this.sessions, run, group)}\n\n现在轮到你进行第 ${round}/${rounds} 轮发言。接着前席已经提交的内容处理你负责的${ROLE_LABELS[group.role]}工作，明确回应前席成果、修正或分歧。施工成果写明实际文件路径，方便下一席查验。`);
        assertActive();
        if (mInfo) { mInfo.color = 'green'; mInfo.statusText = '已提交本轮成果'; }
      }
      }

      group.statusText = '组长定稿中';
      this.emit(run.sessionId);

      const formalPrompt = `【当前阶段：${stageTitle}】\n${sourceContext}\n\n【本组完整已提交讨论】\n${discussionContext(this.sessions, run, group)}\n\n指定的 ${rounds} 轮讨论已经结束。请审阅完整讨论，判断能否交付；阻碍交付的分歧须列入 blockers，不自行追加轮数。只返回 JSON：{"ready":true或false,"text":"本组完整正式成果","blockers":["阻碍交付的问题"]}。仅在确实可交付、text 非空且 blockers 为空时 ready=true。${isReview ? '审验正式结论的 text 第一行必须为 [明确通过] 或 [退回修改]；退回意见本身可以是 ready=true 的正式审验成果，交由既有流程执行退回。' : '正式成果须保留可供后续席位查验的实际文件路径。'}`;
      const formalRes = await invoke(leaderSeat, 'formal', 0, formalPrompt);
      assertActive();
      const decision = extractFormalDecision(formalRes.text);
      if (!decision.ready) {
        group.blocked = true;
        group.blockedMeetingKey = meetingKey;
        group.blockers = decision.blockers;
        group.stopped = true;
        group.canResume = true;
        group.color = 'red';
        group.statusText = `本组受阻：${decision.blockers.join('；')}`;
        this.persistGroupState(run, group);
        this.emit(run.sessionId);
        return { stopped: true, blocked: true, blockers: decision.blockers };
      }

      const version = `${group.role}-v${attempt}`;
      group.formalVersion = version;
      group.formalText = decision.text;

      if (parentAgent) {
        assertActive();
        await this.sessions.appendMainAssistantMessage(parentAgent, {
          messageId: handoffId,
          taskId: run.taskId,
          groupLabel: group.label,
          actorLabel: leaderSeat.label,
          title: `${group.label} · 组长 ${leaderSeat.label}`,
          role: group.role,
          participantId: leaderSeat.id,
          providerId: leaderSeat.model.providerId,
          modelId: leaderSeat.model.modelId,
          phase: isReview ? `${stageTitle}` : group.role,
          groupKey: group.key,
          formalVersion: version,
          text: decision.text,
          sourceId: formalRes.sourceId
        });
      }
      assertActive();
      group.handoffs ??= {};
      group.handoffs[meetingKey] = handoffId;
      group.handoffReceived = true;
      group.blocked = false;
      group.blockers = [];
      group.color = 'green';
      group.statusText = '正式成果已转交';
      for (const member of group.members) { member.color = 'green'; member.statusText = '已完成交接'; }
      this.persistGroupState(run, group);
      this.sessions.updateGroupCheckpoint(run.sessionId, group.key, run.taskId, cp => {
        cp.status = 'completed'; cp.handoffId = handoffId; cp.fault = null;
      });
      this.emit(run.sessionId);
      return { stopped: false, text: decision.text, version, sourceId: formalRes.sourceId, handoffId };
    } catch (err) {
      try {
        const failed = this.sessions.readGroupCheckpoint(run.sessionId, group.key, run.taskId);
        if (failed?.status === 'active' && !failed.fault) this.sessions.updateGroupCheckpoint(run.sessionId, group.key, run.taskId, cp => {
          const next = cp.turns.find(turn => turn.turnId === cp.nextTurnId);
          cp.fault = { turnId: next?.turnId ?? null, actorId: next?.actorId ?? group.leaderId,
            discussionRound: next?.discussionRound ?? 0, code: err.code ?? 'GROUP_STAGE_FAILED', reason: err.message };
        });
      } catch {}
      if (err.mainContextUncommittedBrief) {
        group.blocked = true;
        group.blockedMeetingKey = meetingKey;
        group.blockers = [err.message];
        group.stopped = true;
        group.canResume = true;
      }
      if (groupCtrl.signal.aborted || err.message === 'GROUP_STOPPED' || err.message === 'TASK_STOPPED') {
        group.color = 'neutral';
        group.statusText = '已停止';
        if (err.mainContextUncommittedBrief) this.persistGroupState(run, group);
        this.emit(run.sessionId);
        return { stopped: true };
      }
      if (['CABINET_EMPTY_VISIBLE_BODY', 'CABINET_TOOL_BUDGET_EXHAUSTED', 'CABINET_SPEECH_ONLY_BLOCKED'].includes(err.code) || (typeof err.code === 'string' && err.code.startsWith('MAIN_CONTEXT_'))) {
        if (['CABINET_EMPTY_VISIBLE_BODY', 'CABINET_TOOL_BUDGET_EXHAUSTED', 'CABINET_SPEECH_ONLY_BLOCKED'].includes(err.code)) {
          const member = group.members.find(item => item.id === group.lastSpeechFailure?.actorId);
          if (member) { member.color = 'red'; member.statusText = err.code === 'CABINET_TOOL_BUDGET_EXHAUSTED'
            ? '本棒受阻：工具轮次已用尽' : '本棒受阻：未返回非空可见正文'; }
        }
        group.blocked = true;
        group.blockedMeetingKey = meetingKey;
        group.blockers = [err.message];
        group.stopped = true;
        group.canResume = true;
        group.color = 'red';
        group.statusText = `本组受阻：${err.message}`;
        this.persistGroupState(run, group);
        this.emit(run.sessionId);
        return { stopped: true, blocked: true, blockers: group.blockers, code: err.code };
      }
      group.color = 'red';
      group.statusText = `需人工排障：${err.message}`;
      const fault = this.sessions.readGroupCheckpoint(run.sessionId, group.key, run.taskId)?.fault;
      group.lastSpeechFailure = { ...fault, taskId: run.taskId, groupKey: group.key, stageKey: meetingKey };
      group.stopped = true; group.canResume = true;
      this.persistGroupState(run, group);
      this.emit(run.sessionId);
      throw err;
    } finally {
      taskSignal?.removeEventListener('abort', onTaskAbort);
      if (this.groupControllers.get(ctrlKey) === groupCtrl) this.groupControllers.delete(ctrlKey);
    }
  }

  async executeIndependentStage(run, parentAgent, ind, { stageTitle, promptContext, allowWrite = false, isReview = false, taskSignal, stageKey = null, attempt = 1 }) {
    if (run.stoppedAll) return { stopped: true };
    const seat = run.config.seats.find(s => s.id === ind.id);
    if (!seat) return { stopped: false, text: '' };
    const epoch = ind.executionEpoch ?? 0;
    const epochParts = epoch ? ['meeting', epoch] : [];
    const independentStageKey = `${stageKey || stageTitle}:attempt-${attempt}:revision-${run.round}:meeting-${epoch}`;
    const handoffId = stableId('cab-handoff', run.sessionId, run.taskId, ind.key, stageKey || stageTitle, attempt, run.round, ...epochParts);
    try {
      ind.color = 'yellow';
      ind.statusText = `${stageTitle}进行中`;
      this.emit(run.sessionId);

      const prompt = isReview
        ? `${promptContext}\n\n请完成${stageTitle}。第一行请写明 [明确通过] 或 [退回修改]，若退回请逐条列出需修改的具体问题。`
        : `${promptContext}\n\n请完成${stageTitle}并输出完整成果。`;

      const res = await this.invokeActorWithTools({
        run, seat, role: ind.role, roleBadge: `${ROLE_LABELS[ind.role]} · ${seat.label}`,
        stageTitle, userPrompt: prompt, allowWrite, signal: taskSignal,
        turnId: stableId('cab-turn', run.sessionId, run.taskId, ind.key, stageKey || stageTitle, attempt, run.round, ...epochParts),
        phase: 'independent', stageKey: independentStageKey,
        parentAgent, independentKey: ind.key, mainHandoffId: handoffId
      });
      taskSignal?.throwIfAborted?.();
      if (run.stoppedAll || this.runs.get(run.sessionId) !== run) return { stopped: true };
      ind.outputText = res.text;
      ind.color = 'green';
      ind.statusText = '成果已成功转交';

      if (parentAgent) {
        await this.sessions.appendMainAssistantMessage(parentAgent, {
          messageId: handoffId,
          taskId: run.taskId,
          actorLabel: seat.label,
          groupLabel: ind.label,
          title: `${stageTitle} · ${seat.label}`,
          role: ind.role,
          participantId: seat.id,
          providerId: seat.model.providerId,
          modelId: seat.model.modelId,
          phase: isReview ? stageTitle : ind.role,
          text: res.text,
          sourceId: res.sourceId
        });
      }
      ind.blocked = false;
      ind.handoffs ??= {};
      ind.handoffs[independentStageKey] = handoffId;
      ind.formalOutputRef = { stageKey: independentStageKey, sourceId: res.sourceId };
      this.persistGlobalInstructions(run);
      this.emit(run.sessionId);
      return { stopped: false, text: res.text, sourceId: res.sourceId };
    } catch (err) {
      if (err.mainContextUncommittedBrief) {
        ind.blocked = true;
        ind.blockedStageKey = independentStageKey;
        this.persistGlobalInstructions(run);
      }
      if (taskSignal?.aborted || err.message === 'TASK_STOPPED') {
        ind.color = 'neutral';
        ind.statusText = '已停止';
        this.emit(run.sessionId);
        return { stopped: true };
      }
      if (typeof err.code === 'string' && err.code.startsWith('MAIN_CONTEXT_')) {
        ind.blocked = true;
        ind.blockedStageKey = independentStageKey;
        ind.color = 'red';
        ind.statusText = `需人工排障：${err.message}`;
        run.error = err.message;
        this.persistGlobalInstructions(run);
        this.emit(run.sessionId);
        return { stopped: true, blocked: true, blockers: [err.message], code: err.code };
      }
      ind.color = 'red';
      ind.statusText = `需人工排障：${err.message}`;
      this.emit(run.sessionId);
      throw err;
    }
  }

  async runTask(sessionId, parentAgent, userText = '', options = {}) {
    if (options.isResume || options.resumeOnlyGroupKey) throw checkpointError('CHECKPOINT_SELECTION_REQUIRED', '请使用显式断点接续入口');
    const currentRun = this.runs.get(sessionId);
    const existing = this.taskFlights.get(sessionId);
    if (existing?.run === currentRun) {
      if (options.isResume || options.resumeOnlyGroupKey) {
        await existing.promise;
        return this.runTask(sessionId, parentAgent, userText, options);
      }
      return existing.promise;
    }
    const promise = this._runTask(sessionId, parentAgent, userText, options);
    const flight = { run: currentRun, promise };
    this.taskFlights.set(sessionId, flight);
    try { return await promise; }
    finally { if (this.taskFlights.get(sessionId) === flight) this.taskFlights.delete(sessionId); }
  }

  async _runTask(sessionId, parentAgent, userText = '', options = {}) {
    const run = this.runs.get(sessionId);
    if (!run) return null;
    if (typeof run.originalUserMessage !== 'string') {
      const original = run.lastTaskPrompt ?? userText;
      if (original?.trim()) {
        run.originalUserMessage = original;
        run.lastTaskPrompt = original;
        this.persistGlobalInstructions(run);
      }
    }
    const taskPrompt = run.taskGoalText || run.originalUserMessage || '执行当前内阁任务';

    if (run.awaitingHumanApproval) {
      if (!/^(?:认可|认可此版|同意|通过|继续施工)$/.test(userText.trim())) return run;
      run.awaitingHumanApproval = false;
      run.humanApproved = true;
      if (run.designArtifact) run.designArtifact.approved = true;
      this.persistGlobalInstructions(run);
    } else if (run.userAcceptanceStatus === 'awaiting-user' && /验收通过|确认验收/i.test(userText)) {
      run.userAcceptanceStatus = 'accepted';
      run.stage = 'accepted';
      run.stageLabel = '用户已确认验收';
      this.emit(sessionId);
      return run;
    }
    if (run.stoppedAll || (run.stage === 'awaiting-user-acceptance' && !options.resumeOnlyGroupKey)) return run;

    run.taskDiscussionRounds = resolveDiscussionRounds({ discussionRounds: run.taskDiscussionRounds ?? run.config.discussionRounds });
    const taskCtrl = new AbortController();
    this.taskControllers.set(sessionId, taskCtrl);
    const taskSignal = taskCtrl.signal;

    try {
      const findUnits = (role, target = null) => ({
        groups: run.groups.filter(g => g.role === role),
        inds: run.independents.filter(i => i.role === role && (!target || (i.reviewTargets ?? ['design', 'construction']).includes(target)))
      });
      const dU = findUnits('design'), drU = findUnits('review', 'design');
      const cU = findUnits('construction'), crU = findUnits('review', 'construction');

      if ((dU.groups.length || dU.inds.length) && !run.designArtifact?.approved) {
        let reviewFeedback = run.rootPosition?.designFeedback ?? '';
        for (let attempt = run.rootPosition?.designAttempt ?? 1; attempt <= 2; attempt++) {
          run.rootPosition = { ...run.rootPosition, designAttempt: attempt, designFeedback: reviewFeedback };
          run.stage = 'design';
          run.stageLabel = attempt > 1 ? `设计修改（第 ${attempt} 轮）` : '设计方案制定中';
          this.emit(sessionId);
          const dOut = [];
          for (const g of dU.groups) {
            const r = await this.executeGroupStage(run, parentAgent, g, { stageTitle: '设计方案', stageKey: 'design', attempt, promptContext: `【任务要求】\n${taskPrompt}${reviewFeedback ? `\n\n【审验退回意见】\n${reviewFeedback}` : ''}`, allowWrite: false, taskSignal });
            if (r.stopped) return run;
            if (r.text) dOut.push(r.text);
          }
          for (const ind of dU.inds) {
            const r = await this.executeIndependentStage(run, parentAgent, ind, { stageTitle: '设计方案', stageKey: 'design', attempt, promptContext: `【任务要求】\n${taskPrompt}${reviewFeedback ? `\n\n【审验退回意见】\n${reviewFeedback}` : ''}`, allowWrite: false, taskSignal });
            if (r.stopped) return run;
            if (r.text) dOut.push(r.text);
          }
          const combined = dOut.join('\n\n');
          run.designArtifact = { version: `design-v${attempt}`, text: combined, approved: false };
          await this.runSecretaryReport(run, parentAgent, { kind: 'stage', stageSummary: `已完成设计稿（${run.designArtifact.version}），进入设计审验。`, details: combined });

          if (drU.groups.length || drU.inds.length) {
            run.stage = 'design-review';
            run.stageLabel = '设计审验中';
            this.emit(sessionId);
            const revs = [];
            for (const g of drU.groups) {
              const r = await this.executeGroupStage(run, parentAgent, g, { stageTitle: '设计审验', stageKey: 'design-review', attempt, promptContext: `【任务要求】\n${taskPrompt}\n\n【待审设计方案】\n${combined}`, isReview: true, taskSignal });
              if (r.stopped) return run;
              const dec = extractReviewDecision(r.text);
              g.reviewConclusion = dec.conclusion;
              revs.push(dec);
            }
            for (const ind of drU.inds) {
              const r = await this.executeIndependentStage(run, parentAgent, ind, { stageTitle: '设计审验', stageKey: 'design-review', attempt, promptContext: `【任务要求】\n${taskPrompt}\n\n【待审设计方案】\n${combined}`, isReview: true, taskSignal });
              if (r.stopped) return run;
              const dec = extractReviewDecision(r.text);
              ind.reviewConclusion = dec.conclusion;
              revs.push(dec);
            }
            const rejected = revs.find(d => d.conclusion === 'changes');
            if (rejected && attempt === 2) {
              run.stage = 'design-blocked';
              run.stageLabel = '设计审验未通过';
              run.error = rejected.summary;
              this.emit(sessionId);
              return run;
            }
            if (rejected && attempt < 2) {
              reviewFeedback = rejected.summary;
              run.rootPosition = { ...run.rootPosition, designAttempt: attempt + 1, designFeedback: reviewFeedback };
              this.persistGlobalInstructions(run);
              await this.runSecretaryReport(run, parentAgent, { kind: 'stage', stageSummary: '设计审验提出修改意见，返回设计席修订。', details: rejected.summary });
              continue;
            }
          }
          run.designArtifact.approved = true;
          break;
        }
        if (run.config.policies?.humanApprovalRequired === true && !run.humanApproved) {
          run.awaitingHumanApproval = true;
          run.stage = 'awaiting-human-approval';
          run.stageLabel = '设计审验已通过 · 等待本人确认';
          this.emit(sessionId);
          return run;
        }
      }
      return await this._finishConstructionAndDelivery(run, parentAgent, taskPrompt, { cU, crU, taskSignal, options });
    } catch (err) {
      if (!taskSignal.aborted) {
        run.error = err.message;
        run.stageLabel = `执行受阻：${err.message}`;
        this.emit(sessionId);
      }
      return run;
    } finally {
      if (this.taskControllers.get(sessionId) === taskCtrl) this.taskControllers.delete(sessionId);
    }
  }

  async _finishConstructionAndDelivery(run, parentAgent, taskPrompt, { cU, crU, taskSignal, options = {} }) {
    const sessionId = run.sessionId;
    if (cU.groups.length || cU.inds.length) {
      const designText = run.designArtifact?.text || run.config.existingDesign?.text || '按任务要求直接实施';
      let reviewFeedback = run.rootPosition?.constructionFeedback ?? '';
      for (let attempt = run.rootPosition?.constructionAttempt ?? 1; attempt <= 2; attempt++) {
        run.rootPosition = { ...run.rootPosition, constructionAttempt: attempt, constructionFeedback: reviewFeedback };
        run.stage = 'construction';
        run.stageLabel = attempt > 1 ? `施工返工（第 ${attempt} 轮）` : '按认可设计施工中';
        this.emit(sessionId);
        const bOut = [];
        for (const g of cU.groups) {
          const r = await this.executeGroupStage(run, parentAgent, g, { stageTitle: '工程施工', stageKey: 'construction', attempt, promptContext: `【任务要求】\n${taskPrompt}\n\n【已认可设计方案】\n${designText}${reviewFeedback ? `\n\n【审验退回意见】\n${reviewFeedback}` : ''}`, allowWrite: true, taskSignal });
          if (r.stopped) return run;
          if (r.text) bOut.push(r.text);
        }
        for (const ind of cU.inds) {
          const r = await this.executeIndependentStage(run, parentAgent, ind, { stageTitle: '工程施工', stageKey: 'construction', attempt, promptContext: `【任务要求】\n${taskPrompt}\n\n【已认可设计方案】\n${designText}${reviewFeedback ? `\n\n【审验退回意见】\n${reviewFeedback}` : ''}`, allowWrite: true, taskSignal });
          if (r.stopped) return run;
          if (r.text) bOut.push(r.text);
        }
        const combinedBuild = bOut.join('\n\n');
        run.constructionArtifact = { version: `build-v${attempt}`, text: combinedBuild };
        await this.runSecretaryReport(run, parentAgent, { kind: 'stage', stageSummary: `施工已完成（${run.constructionArtifact.version}），进入施工审验。`, details: combinedBuild });

        if (crU.groups.length || crU.inds.length) {
          run.stage = 'construction-review';
          run.stageLabel = '施工审验中';
          this.emit(sessionId);
          const bRevs = [];
          for (const g of crU.groups) {
            const r = await this.executeGroupStage(run, parentAgent, g, { stageTitle: '施工审验', stageKey: 'construction-review', attempt, promptContext: `【已认可设计】\n${designText}\n\n【施工成果】\n${combinedBuild}`, isReview: true, taskSignal });
            if (r.stopped) return run;
            const dec = extractReviewDecision(r.text);
            g.reviewConclusion = dec.conclusion;
            bRevs.push(dec);
          }
          for (const ind of crU.inds) {
            const r = await this.executeIndependentStage(run, parentAgent, ind, { stageTitle: '施工审验', stageKey: 'construction-review', attempt, promptContext: `【已认可设计】\n${designText}\n\n【施工成果】\n${combinedBuild}`, isReview: true, taskSignal });
            if (r.stopped) return run;
            const dec = extractReviewDecision(r.text);
            ind.reviewConclusion = dec.conclusion;
            bRevs.push(dec);
          }
          const rejected = bRevs.find(d => d.conclusion === 'changes');
          if (rejected && attempt === 2) {
            run.stage = 'construction-blocked';
            run.stageLabel = '施工审验未通过';
            run.error = rejected.summary;
            this.emit(sessionId);
            return run;
          }
          if (rejected && attempt < 2) {
            reviewFeedback = rejected.summary;
            run.rootPosition = { ...run.rootPosition, constructionAttempt: attempt + 1, constructionFeedback: reviewFeedback };
            this.persistGlobalInstructions(run);
            await this.runSecretaryReport(run, parentAgent, { kind: 'stage', stageSummary: '施工审验发现问题，退回施工席返工。', details: rejected.summary });
            continue;
          }
        }
        break;
      }
    }

    taskSignal?.throwIfAborted?.();
    if (run.stoppedAll || this.runs.get(run.sessionId) !== run) return run;
    const finalDeliverable = {
      id: stableId('deliv', run.sessionId, run.taskId, run.constructionArtifact?.version, run.designArtifact?.version),
      version: run.constructionArtifact?.version || run.designArtifact?.version || `v${run.round}`,
      at: new Date().toISOString(),
      designText: run.designArtifact?.text || '',
      constructionText: run.constructionArtifact?.text || ''
    };
    if (!run.deliverables.some(item => item.id === finalDeliverable.id)) run.deliverables.push(finalDeliverable);
    run.stage = 'finalizing-delivery';
    run.stageLabel = '正在完成主对话交付';
    this.emit(sessionId);
    return this._completeFinalDelivery(run, parentAgent, finalDeliverable, taskSignal);
  }

  async _completeFinalDelivery(run, parentAgent, finalDeliverable, taskSignal) {
    const sessionId = run.sessionId;
    if (!finalDeliverable) throw checkpointError('CHECKPOINT_RESULT_MISSING', '最终收尾缺少原已交付成果');
    await this.runSecretaryReport(run, parentAgent, {
      kind: 'final',
      stageSummary: FINAL_DELIVERY_SUMMARY,
      details: [finalDeliverable.designText, finalDeliverable.constructionText].filter(Boolean).join('\n\n')
    });
    taskSignal?.throwIfAborted?.();
    if (run.stoppedAll || this.runs.get(sessionId) !== run) return run;
    run.stage = 'awaiting-user-acceptance';
    run.stageLabel = '已交付主对话 · 等待用户验收';
    run.userAcceptanceStatus = 'awaiting-user';
    this.emit(sessionId);
    return run;
  }
}

