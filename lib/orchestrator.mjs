import crypto from 'node:crypto';
import { shortenModelName, normalizeReasoningEffort, STANDARD_REASONING_EFFORTS } from './model-catalog.mjs';

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

export const PRESET_MODES = Object.freeze({
  'classic-3': { id: 'classic-3', label: '经典模式 (3席)', shortLabel: '经典模式', slotCount: 3, requiresSecretary: false },
  'classic-9': { id: 'classic-9', label: '经典模式 (9席)', shortLabel: '经典9席', slotCount: 9, requiresSecretary: false },
  'minimal': { id: 'minimal', label: '极简模式', shortLabel: '极简模式', slotCount: 2, requiresSecretary: false },
  'brainstorm': { id: 'brainstorm', label: '头脑风暴', shortLabel: '头脑风暴', slotCount: 8, requiresSecretary: true },
  'six-chancellors': { id: 'six-chancellors', label: '六国大封相', shortLabel: '六国大封相', slotCount: 9, requiresSecretary: true },
  'free': { id: 'free', label: '自由模式', shortLabel: '自由模式', slotCount: null, requiresSecretary: false }
});

export const DEFAULT_POLICIES = Object.freeze({
  handoff: 'wait',
  humanApprovalRequired: false,
  constructionExecutionMode: 'parallel',
  memberPool: { scope: 'group', seatIds: [] }
});

const DESIGN_REVIEW_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    conclusion: { type: 'string', enum: ['pass', 'changes'], description: '审验结论：pass 表示通过，changes 表示退回修改' },
    summary: { type: 'string', description: '审验结论摘要与具体意见（退回时必须列明具体修改要求）' }
  },
  required: ['conclusion', 'summary'],
  additionalProperties: false
});

const CONSTRUCTION_REVIEW_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    conclusion: { type: 'string', enum: ['pass', 'changes'], description: '审验结论：pass 表示通过，changes 表示退回返工' },
    rejectTarget: {
      type: 'string',
      enum: ['construction', 'design'],
      description: '当 conclusion 为 changes 时的退回目标：笔误、实现瑕疵或漏改选 construction（退回施工席返工）；原设计方案有底层硬伤选 design（打回设计组重出方案）。通过时填 construction。'
    },
    summary: { type: 'string', description: '审验结论摘要与具体核查依据（退回时必须列明具体问题位置与修改要求）' }
  },
  required: ['conclusion', 'rejectTarget', 'summary'],
  additionalProperties: false
});

const CONSTRUCTION_SHARD_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    shards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          memberId: { type: 'string', description: '施工组员席位 ID' },
          task: { type: 'string', description: '该施工组员负责的具体施工子任务说明' },
          ownedPaths: {
            type: 'array',
            items: { type: 'string' },
            description: '分配给该组员独占修改的文件或目录相对路径白名单（若不限制可填 ["*"]）'
          }
        },
        required: ['memberId', 'task', 'ownedPaths'],
        additionalProperties: false
      }
    },
    integrationNotes: { type: 'string', description: '跨分片公共接口约定与注意事项' }
  },
  required: ['shards', 'integrationNotes'],
  additionalProperties: false
});

export function getPresetSeatTemplates(presetMode) {
  const duty = (role, kind = 'member', extra = {}) => ({
    role,
    kind,
    groupId: `${role}-group`,
    groupName: `${ROLE_LABELS[role]}组`,
    ...(role === 'review' ? { reviewTargets: extra.reviewTargets || ['design', 'construction'] } : {})
  });

  switch (presetMode) {
    case 'classic-3':
      return [
        [duty('design', 'member')],
        [duty('construction', 'member')],
        [duty('review', 'member', { reviewTargets: ['design', 'construction'] })]
      ];
    case 'classic-9':
      return [
        [duty('design', 'leader')],
        [duty('design', 'member')],
        [duty('design', 'member')],
        [duty('construction', 'leader')],
        [duty('construction', 'member')],
        [duty('construction', 'member')],
        [duty('review', 'leader', { reviewTargets: ['design', 'construction'] })],
        [duty('review', 'member', { reviewTargets: ['design', 'construction'] })],
        [duty('review', 'member', { reviewTargets: ['design', 'construction'] })]
      ];
    case 'minimal':
      return [
        [duty('construction', 'member')],
        [duty('design', 'member'), duty('review', 'member', { reviewTargets: ['construction'] })]
      ];
    case 'brainstorm':
      return [
        [duty('design', 'member')],
        [duty('design', 'member')],
        [duty('design', 'member')],
        [duty('design', 'member')],
        [duty('review', 'member', { reviewTargets: ['design'] })],
        [duty('review', 'member', { reviewTargets: ['design'] })],
        [duty('review', 'member', { reviewTargets: ['design'] })],
        [duty('review', 'member', { reviewTargets: ['design'] })]
      ];
    case 'six-chancellors':
      return [
        [duty('design', 'member')],
        [duty('design', 'member')],
        [duty('design', 'member')],
        [duty('design', 'member')],
        [duty('construction', 'member')],
        [duty('review', 'member', { reviewTargets: ['design', 'construction'] })],
        [duty('review', 'member', { reviewTargets: ['design', 'construction'] })],
        [duty('review', 'member', { reviewTargets: ['design', 'construction'] })],
        [duty('review', 'member', { reviewTargets: ['design', 'construction'] })]
      ];
    default:
      return null;
  }
}

export function buildPresetConfig(presetMode, currentConfig = {}) {
  const templates = getPresetSeatTemplates(presetMode);
  const base = normalizeConfig(currentConfig, currentConfig.kind || 'plan');
  if (!templates) {
    return { ...base, presetMode: 'free' };
  }

  // 收集当前已在工作席上的模型（按 seatIndex 升序），超出新预设槽位数的模型直接卸载，待放区最多保留 1 个模型
  const existingSeatModels = [...base.seats]
    .filter(s => s.inSeat !== false && s.model)
    .sort((a, b) => (a.seatIndex ?? 0) - (b.seatIndex ?? 0))
    .map(s => s.model);

  const staging = Array.isArray(base.staging) ? base.staging.slice(-1) : [];
  const newSeats = templates.map((duties, idx) => {
    const reusedModel = existingSeatModels[idx] || null;
    return {
      id: `seat-${idx + 1}`,
      label: reusedModel?.shortLabel || `席位${idx + 1}`,
      seatIndex: idx,
      inSeat: true,
      model: reusedModel,
      duties
    };
  });

  return normalizeConfig({
    ...base,
    presetMode,
    slotCount: templates.length,
    seats: newSeats,
    staging,
    policies: {
      ...base.policies,
      constructionExecutionMode: 'parallel'
    }
  }, base.kind || 'plan');
}

function isExactMinimalLayout(slotCount, seats) {
  if (slotCount !== 2) return false;
  const active = seats.filter(s => s.inSeat !== false && Array.isArray(s.duties) && s.duties.length > 0);
  if (active.length !== 2) return false;
  const hasSingleConstruction = active.some(s => s.duties.length === 1 && s.duties[0].role === 'construction' && s.duties[0].kind !== 'leader');
  const hasCombinedDesignReview = active.some(s => {
    if (s.duties.length !== 2) return false;
    const roles = s.duties.map(d => d.role).sort().join(',');
    return roles === 'design,review' && s.duties.every(d => d.kind !== 'leader');
  });
  return hasSingleConstruction && hasCombinedDesignReview;
}

export function normalizeConfig(raw = {}, kind = 'task') {
  const execMode = raw.policies?.constructionExecutionMode === 'sequential' ? 'sequential' : 'parallel';
  const policies = {
    handoff: raw.policies?.handoff || DEFAULT_POLICIES.handoff,
    humanApprovalRequired: raw.policies?.humanApprovalRequired === true,
    constructionExecutionMode: execMode,
    memberPool: raw.policies?.memberPool?.scope
      ? { scope: raw.policies.memberPool.scope, seatIds: Array.isArray(raw.policies.memberPool.seatIds) ? raw.policies.memberPool.seatIds : [] }
      : { ...DEFAULT_POLICIES.memberPool }
  };

  const toModelRef = ref => {
    if (ref && typeof ref === 'object' && (ref.providerId || ref.provider) && (ref.modelId || ref.model)) {
      const providerId = ref.providerId ?? ref.provider;
      const modelId = ref.modelId ?? ref.model;
      const opts = Array.isArray(ref.reasoningEffortOptions) && ref.reasoningEffortOptions.length
        ? ref.reasoningEffortOptions
        : [...STANDARD_REASONING_EFFORTS];
      return {
        providerId,
        providerName: ref.providerName ?? providerId,
        modelId,
        displayName: ref.displayName ?? ref.label ?? modelId,
        shortLabel: ref.shortLabel ?? shortenModelName(modelId, ref.displayName ?? ref.label),
        reasoningEffort: normalizeReasoningEffort(ref.reasoningEffort),
        reasoningEffortOptions: opts,
        declaredEfforts: Array.isArray(ref.declaredEfforts) ? ref.declaredEfforts : [],
        effortDeclared: Boolean(ref.effortDeclared)
      };
    }
    return null;
  };

  let presetMode = PRESET_MODES[raw.presetMode] ? raw.presetMode : 'free';
  const rawSeats = Array.isArray(raw.seats) ? raw.seats : [];
  let seats = rawSeats
    .map((s, idx) => {
      if (!s || typeof s !== 'object') return null;
      const model = toModelRef(s.model);
      const rawDuties = Array.isArray(s.duties) ? s.duties.filter(d => d && ROLE_LABELS[d.role]) : [];
      // 保留有模型或者预装了职责的槽位
      if (!model && rawDuties.length === 0) return null;
      const seatIndex = Number.isInteger(s.seatIndex) ? s.seatIndex : idx;
      const duties = rawDuties.map(d => {
        const normalizedKind = d.kind === 'leader' ? 'leader' : 'member';
        const validTargets = Array.isArray(d.reviewTargets)
          ? d.reviewTargets.filter(t => t === 'design' || t === 'construction')
          : [];
        return {
          role: d.role,
          kind: normalizedKind,
          groupId: d.groupId || `${d.role}-group`,
          groupName: d.groupName || `${ROLE_LABELS[d.role]}组`,
          ...(d.role === 'review' ? { reviewTargets: validTargets.length ? validTargets : ['design', 'construction'] } : {})
        };
      });
      return {
        id: s.id || `seat-${seatIndex + 1}`,
        label: model?.shortLabel || s.label || `席位${seatIndex + 1}`,
        seatIndex,
        inSeat: s.inSeat !== false,
        model,
        duties
      };
    })
    .filter(Boolean);

  const slotCount = Math.min(9, Math.max(1, Number.isInteger(raw.slotCount) ? raw.slotCount : Math.max(2, seats.length || 3)));

  // 极简模式破格检查：非极简模式或破坏极简 2 席布局时，若存在同席兼任设计与审验，仅弹回审验，保留设计在原席位上
  const allowMinimalDualDuty = presetMode === 'minimal' && isExactMinimalLayout(slotCount, seats);
  let minimalBroken = false;
  seats = seats.map(s => {
    if (s.duties.length <= 1) return s;
    const hasDesign = s.duties.some(d => d.role === 'design');
    const hasReview = s.duties.some(d => d.role === 'review');
    if (hasDesign && hasReview && allowMinimalDualDuty && s.duties.length === 2) {
      return s;
    }
    minimalBroken = true;
    if (hasDesign && hasReview) {
      // 仅弹回审验，保留设计
      return { ...s, duties: s.duties.filter(d => d.role === 'design').slice(0, 1) };
    }
    return { ...s, duties: s.duties.slice(0, 1) };
  });
  if (minimalBroken && presetMode === 'minimal') {
    presetMode = 'free';
  }

  // 当施工席仅有 1 个时，强制为组员（单席直施，不可设组长）
  const activeConstructionSeats = seats.filter(s => s.inSeat && s.duties.some(d => d.role === 'construction'));
  if (activeConstructionSeats.length === 1) {
    const targetId = activeConstructionSeats[0].id;
    seats = seats.map(s => s.id === targetId
      ? { ...s, duties: s.duties.map(d => d.role === 'construction' ? { ...d, kind: 'member' } : d) }
      : s
    );
  }

  const secModel = toModelRef(raw.secretary?.model);
  const secretary = {
    id: 'secretary',
    model: secModel,
    label: secModel ? (raw.secretary?.label || secModel.shortLabel) : '秘书（未配置）'
  };

  const staging = (Array.isArray(raw.staging) ? raw.staging : [])
    .map((item, idx) => {
      const m = toModelRef(item);
      if (!m) return null;
      return {
        id: item.id || `stg-${idx + 1}`,
        ...m
      };
    })
    .filter(Boolean)
    .slice(-1);

  return {
    schemaVersion: 3,
    kind,
    id: raw.id || (kind === 'plan' ? 'default-cabinet-plan' : `task-${Date.now()}`),
    taskId: raw.taskId || raw.id || null,
    revision: Number.isInteger(raw.revision) ? raw.revision : 1,
    configVersion: Number.isInteger(raw.configVersion) ? raw.configVersion : 1,
    presetMode,
    slotCount,
    goal: typeof raw.goal === 'string' ? raw.goal.trim() : '',
    constraints: typeof raw.constraints === 'string' ? raw.constraints.trim() : '',
    existingDesign: raw.existingDesign?.text ? { version: raw.existingDesign.version || 'v1', text: String(raw.existingDesign.text), approved: true } : null,
    secretary,
    seats,
    staging,
    participants: seats.filter(s => s.inSeat && s.duties.length > 0).map(s => s.id),
    policies
  };
}

export function validateCabinetConfig(raw = {}, kind = 'task') {
  let normalized;
  try {
    normalized = normalizeConfig(raw, kind);
  } catch (err) {
    return { ok: false, value: null, errors: [{ code: err.code || 'INVALID_CONFIG', message: err.message }], warnings: [], groups: [] };
  }

  const errors = [];
  const warnings = [];
  const activeSeats = normalized.seats.filter(s => s.inSeat);
  if (!activeSeats.length) {
    errors.push({ code: 'NO_WORKERS', message: '至少需要安排 1 个工作席。' });
  }

  for (const s of activeSeats) {
    if (!s.duties.length) {
      errors.push({ code: 'SEAT_NO_DUTY', seatId: s.id, message: `工作席「${s.label}」尚未分配职责（设计/施工/审验）。` });
    }
    if (kind === 'task' && !s.model) {
      errors.push({ code: 'SEAT_NO_MODEL', seatId: s.id, message: `工作席「${s.label}」（席 ${s.seatIndex + 1}）尚未拖入模型。` });
    }
    if (s.model?.reasoningEffort && s.model.effortDeclared && Array.isArray(s.model.reasoningEffortOptions)) {
      if (!s.model.reasoningEffortOptions.includes(s.model.reasoningEffort)) {
        errors.push({
          code: 'UNSUPPORTED_REASONING_EFFORT',
          seatId: s.id,
          message: `工作席「${s.label}」（${s.model.shortLabel || s.model.modelId}）不支持思考档位「${s.model.reasoningEffort}」，仅支持：${s.model.reasoningEffortOptions.join(' / ') || '默认'}。`
        });
      }
    }
  }
  if (normalized.secretary?.model?.reasoningEffort && normalized.secretary.model.effortDeclared && Array.isArray(normalized.secretary.model.reasoningEffortOptions)) {
    const secM = normalized.secretary.model;
    if (!secM.reasoningEffortOptions.includes(secM.reasoningEffort)) {
      errors.push({
        code: 'UNSUPPORTED_REASONING_EFFORT',
        seatId: 'secretary',
        message: `秘书席（${secM.shortLabel || secM.modelId}）不支持思考档位「${secM.reasoningEffort}」，仅支持：${secM.reasoningEffortOptions.join(' / ') || '默认'}。`
      });
    }
  }

  // 校验预设模式必配秘书席
  const presetMeta = PRESET_MODES[normalized.presetMode];
  if (presetMeta?.requiresSecretary && !normalized.secretary?.model) {
    errors.push({
      code: 'SECRETARY_REQUIRED',
      message: `「${presetMeta.shortLabel}」模式必须配置秘书席模型。`
    });
  }

  // 按角色聚合席位
  const roleMap = new Map();
  for (const role of ['design', 'construction', 'review']) {
    roleMap.set(role, {
      key: `${role}::${role}-group`,
      role,
      groupId: `${role}-group`,
      label: `${ROLE_LABELS[role]}组`,
      leaders: [],
      members: [],
      participantIds: []
    });
  }

  // 检查原始输入是否有 1 席施工被强塞 leader（在 normalize 自动降级前捕获显式错误或校验）
  const rawActiveConstruction = (Array.isArray(raw?.seats) ? raw.seats : []).filter(
    s => s && s.inSeat !== false && Array.isArray(s.duties) && s.duties.some(d => d?.role === 'construction')
  );
  if (rawActiveConstruction.length === 1) {
    const rawDuty = rawActiveConstruction[0].duties.find(d => d?.role === 'construction');
    if (rawDuty?.kind === 'leader') {
      errors.push({
        code: 'CONSTRUCTION_SINGLE_NO_LEADER',
        message: '施工组仅 1 个席位时为单席直施，不可设立施工组长。'
      });
    }
  }

  for (const s of activeSeats) {
    for (const d of s.duties) {
      const g = roleMap.get(d.role);
      if (!g) continue;
      g.participantIds.push(s.id);
      if (d.kind === 'leader') g.leaders.push(s.id);
      else g.members.push(s.id);
    }
  }

  // 施工席人数与组长铁律
  const cGroup = roleMap.get('construction');
  const cCount = cGroup.participantIds.length;
  if (cCount === 2) {
    errors.push({
      code: 'CONSTRUCTION_INVALID_COUNT',
      groupKey: cGroup.key,
      message: '施工组工作席必须为 1 席或 3 席以上'
    });
  } else if (cCount >= 3) {
    if (cGroup.leaders.length !== 1 || cGroup.members.length !== cCount - 1) {
      errors.push({
        code: 'CONSTRUCTION_LEADER_REQUIRED',
        groupKey: cGroup.key,
        message: '3 席及以上的施工组必须指定 1 位施工组长，且其余施工席均为组员。'
      });
    }
  }

  // 设计组与审验组规则（路线 B：不强制设组长，但若设组长则最多 1 位且至少有 1 位组员）
  for (const role of ['design', 'review']) {
    const g = roleMap.get(role);
    if (g.leaders.length > 1) {
      errors.push({
        code: 'GROUP_MULTI_LEADER',
        groupKey: g.key,
        message: `「${g.label}」最多只能有 1 位组长。`
      });
    }
    if (g.leaders.length === 1 && g.members.length === 0) {
      errors.push({
        code: 'GROUP_NO_MEMBER',
        groupKey: g.key,
        message: `「${g.label}」仅有 1 个席位时无需设组长，请设为组员。`
      });
    }
  }

  // 1:1 盲审配平温和提示
  const dWorkers = roleMap.get('design').members.length || roleMap.get('design').participantIds.length;
  const cWorkers = cCount >= 3 ? cGroup.members.length : cCount;
  const rWorkers = roleMap.get('review').members.length || roleMap.get('review').participantIds.length;
  const targetMax = Math.max(dWorkers, cWorkers);
  if (rWorkers > 0 && targetMax > 0 && rWorkers !== targetMax && normalized.presetMode === 'free') {
    warnings.push({
      code: 'REVIEW_UNBALANCED',
      message: `当前设计/施工有效席位最高为 ${targetMax} 席，审验员为 ${rWorkers} 席；建议按 1:1 配平以启用一对一盲审。`
    });
  }

  const groups = [];
  for (const g of roleMap.values()) {
    if (g.participantIds.length >= 2) {
      groups.push({
        key: g.key,
        role: g.role,
        groupId: g.groupId,
        label: g.label,
        leaderId: g.leaders[0] || null,
        memberIds: g.members,
        participantIds: g.participantIds
      });
    }
  }

  return { ok: errors.length === 0, value: normalized, errors, warnings, groups };
}

function safeAgentSlug(raw) {
  const s = String(raw || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const prefix = /^[a-z]/.test(s) ? s : `seat-${s || 'x'}`;
  return prefix.slice(0, 28);
}

export class CabinetOrchestrator {
  constructor({ teamRuntime, onStateChange, onCompleted = null }) {
    this.runtime = teamRuntime;
    this.onStateChange = onStateChange;
    this.onCompleted = onCompleted;
    this.runs = new Map();
    this.seatCaches = new Map();
    this.taskControllers = new Map();
  }

  getRun(sessionId) {
    return this.runs.get(sessionId) ?? null;
  }

  emit(sessionId) {
    try { this.onStateChange?.(sessionId); } catch {}
  }

  ensureRun(sessionId, config) {
    const validated = validateCabinetConfig(config, 'task');
    const normalized = validated.value ?? normalizeConfig(config, 'task');
    let run = this.runs.get(sessionId);
    if (run && run.taskId === normalized.taskId && run.configVersion === normalized.configVersion) {
      return run;
    }
    run = this._createRun(sessionId, validated, normalized);
    this.runs.set(sessionId, run);
    return run;
  }

  _createRun(sessionId, validated, normalized) {
    let run;
    const groups = validated.groups.map(g => ({
      ...g,
      round: 1,
      color: 'neutral',
      statusText: '等待前序阶段',
      stopped: false,
      reviewConclusion: null,
      formalText: null,
      formalVersion: null,
      boardTaskId: null,
      childIds: {},
      members: g.participantIds.map(pid => {
        const seat = normalized.seats.find(s => s.id === pid);
        const duty = seat?.duties.find(d => d.role === g.role);
        return {
          id: pid,
          label: seat?.label || pid,
          role: g.role,
          kind: duty?.kind || 'member',
          reviewTargets: duty?.reviewTargets ?? ['design', 'construction'],
          roleBadge: `${ROLE_LABELS[g.role]}${KIND_LABELS[duty?.kind || 'member']}`,
          model: seat?.model,
          statusText: '待命',
          color: 'neutral',
          nativeSessionId: null
        };
      })
    }));

    const groupedSeatRoles = new Set();
    for (const g of validated.groups) for (const pid of g.participantIds) groupedSeatRoles.add(`${pid}::${g.role}`);

    const independents = [];
    for (const seat of normalized.seats.filter(s => s.inSeat)) {
      for (const duty of seat.duties) {
        if (!groupedSeatRoles.has(`${seat.id}::${duty.role}`)) {
          independents.push({
            key: `ind::${seat.id}::${duty.role}`,
            id: seat.id,
            label: `${ROLE_LABELS[duty.role]} · ${seat.label}`,
            seatLabel: seat.label,
            role: duty.role,
            kind: duty.kind || 'member',
            reviewTargets: duty.reviewTargets ?? ['design', 'construction'],
            model: seat.model,
            color: 'neutral',
            statusText: '等待前序阶段',
            reviewConclusion: null,
            outputText: null,
            boardTaskId: null,
            nativeSessionId: null
          });
        }
      }
    }

    const secModel = normalized.secretary?.model;
    run = {
      sessionId,
      runId: `run-${crypto.randomUUID().slice(0, 8)}`,
      taskId: normalized.taskId || sessionId,
      configVersion: normalized.configVersion,
      config: normalized,
      presetMode: normalized.presetMode || 'free',
      originalUserMessage: null,
      taskGoalText: normalized.goal,
      stage: 'idle',
      stageLabel: '待命 · 输入任务后自动推进',
      outerCycleCount: 1,
      constructionReworkCount: 0,
      rejectionHistory: [],
      circuitBreaker: null,
      stoppedAll: false,
      awaitingHumanApproval: false,
      humanApproved: normalized.existingDesign?.approved === true,
      userAcceptanceStatus: 'pending',
      groups,
      independents,
      secretary: secModel ? {
        model: secModel,
        label: `秘书 · ${secModel.shortLabel}`,
        color: 'neutral',
        status: 'idle',
        error: null,
        latestBrief: '待任务启动后汇报进度。',
        reports: [],
        nativeSessionId: null
      } : null,
      designProposals: [],
      designArtifact: normalized.existingDesign?.text ? { version: 'v1', text: normalized.existingDesign.text, approved: true } : null,
      constructionArtifact: null,
      deliverables: [],
      boardTaskIds: {},
      queue: [],
      error: null,
      lifecycle: 'idle',
      seatErrors: {},
      designFeedback: '',
      constructionFeedback: '',
      resumePending: false,
      snapCache: {}
    };
    return run;
  }

  _seatSig(seat) {
    const m = seat?.model;
    return m ? `${m.providerId}/${m.modelId}/${m.reasoningEffort ?? ''}` : '';
  }

  _cacheOf(sessionId) {
    let c = this.seatCaches.get(sessionId);
    if (!c) { c = new Map(); this.seatCaches.set(sessionId, c); }
    return c;
  }

  clearCache(sessionId) {
    this.seatCaches.delete(sessionId);
    const run = this.runs.get(sessionId);
    if (run) run.snapCache = {};
  }

  // 中断态热更新排席：沿用模型/档位未变席位已有的子会话与已完成成果缓存
  updateConfig(sessionId, rawConfig) {
    const run = this.runs.get(sessionId);
    if (!run) throw new Error('当前没有可调整的内阁任务');
    if (run.lifecycle === 'running') throw new Error('任务正在执行，请先停止全部工作后再调整');
    const validated = validateCabinetConfig({ ...rawConfig, taskId: run.taskId, configVersion: run.configVersion + 1 }, 'task');
    if (!validated.ok) {
      throw Object.assign(new Error(validated.errors[0]?.message || '任务配置不完整'), { code: 'INVALID_TASK', errors: validated.errors });
    }
    const normalized = validated.value;
    const oldSig = new Map(run.config.seats.map(s => [s.id, this._seatSig(s)]));
    const newSeatSig = id => this._seatSig(normalized.seats.find(s => s.id === id));
    const parts = this._createRun(sessionId, validated, normalized);

    for (const g of parts.groups) {
      const old = run.groups.find(o => o.key === g.key);
      if (!old) continue;
      for (const m of g.members) {
        const om = old.members.find(x => x.id === m.id);
        if (om?.nativeSessionId && oldSig.get(m.id) === newSeatSig(m.id)) {
          m.nativeSessionId = om.nativeSessionId;
          g.childIds[m.id] = old.childIds?.[m.id] ?? om.nativeSessionId;
        }
      }
    }
    for (const ind of parts.independents) {
      const old = run.independents.find(o => o.key === ind.key);
      if (old?.nativeSessionId && oldSig.get(ind.id) === newSeatSig(ind.id)) ind.nativeSessionId = old.nativeSessionId;
    }
    const oldSec = run.secretary;
    if (parts.secretary && oldSec?.nativeSessionId && run.config.secretary?.model && this._seatSig(run.config.secretary) === this._seatSig(normalized.secretary)) {
      parts.secretary.nativeSessionId = oldSec.nativeSessionId;
      parts.secretary.reports = oldSec.reports;
      parts.secretary.latestBrief = oldSec.latestBrief;
    }

    run.config = normalized;
    run.configVersion = normalized.configVersion;
    run.presetMode = normalized.presetMode || 'free';
    if (normalized.goal) run.taskGoalText = normalized.goal;
    run.groups = parts.groups;
    run.independents = parts.independents;
    run.secretary = parts.secretary;
    run.stoppedAll = false;
    run.error = null;
    run.seatErrors = {};
    run.resumePending = true;
    if (run.circuitBreaker) {
      run.circuitBreaker = null;
      run.outerCycleCount = 1;
      run.constructionReworkCount = 0;
      run.designFeedback = '';
      run.constructionFeedback = '';
      this.clearCache(sessionId);
    }
    this.emit(sessionId);
    return { run, normalized };
  }

  stopGroup(sessionId, groupKey) {
    const run = this.runs.get(sessionId);
    if (!run) return null;
    const group = run.groups.find(g => g.key === groupKey || g.groupId === groupKey);
    if (!group) return run;
    group.stopped = true;
    group.color = 'neutral';
    group.statusText = '本组已停止';
    this.runtime.interruptSeats(Object.values(group.childIds ?? {}));
    for (const m of group.members) {
      if (m.color === 'yellow') { m.color = 'neutral'; m.statusText = '已停止'; }
    }
    this.emit(sessionId);
    return run;
  }

  stopAll(sessionId) {
    const run = this.runs.get(sessionId);
    if (!run) return null;
    this.taskControllers.get(sessionId)?.abort(new Error('TASK_STOPPED'));
    run.stoppedAll = true;
    run.lifecycle = 'interrupted';
    run.stageLabel = '全部工作已停止';
    const childIds = [];
    for (const g of run.groups) {
      g.stopped = true;
      if (g.color === 'yellow') g.color = 'neutral';
      g.statusText = '已停止';
      for (const m of g.members) if (m.color === 'yellow') { m.color = 'neutral'; m.statusText = '已停止'; }
      childIds.push(...Object.values(g.childIds ?? {}));
    }
    for (const ind of run.independents) {
      if (ind.color === 'yellow') { ind.color = 'neutral'; ind.statusText = '已停止'; }
      if (ind.nativeSessionId) childIds.push(ind.nativeSessionId);
    }
    if (run.secretary?.nativeSessionId) childIds.push(run.secretary.nativeSessionId);
    this.runtime.interruptSeats(childIds);
    this.emit(sessionId);
    return run;
  }

  endTask(sessionId) {
    const run = this.runs.get(sessionId);
    if (!run) return null;
    this.taskControllers.get(sessionId)?.abort(new Error('TASK_STOPPED'));
    run.stoppedAll = true;
    run.lifecycle = 'ended';
    run.stage = 'ended';
    run.stageLabel = '任务已彻底结束';
    this.clearCache(sessionId);
    this.emit(sessionId);
    return run;
  }

  resumeGroup(sessionId, groupKey) {
    const run = this.runs.get(sessionId);
    if (!run) return null;
    const group = run.groups.find(g => g.key === groupKey || g.groupId === groupKey);
    if (!group) return run;
    group.stopped = false;
    group.color = 'neutral';
    group.statusText = '准备继续';
    if (run.stoppedAll) run.stoppedAll = false;
    this.emit(sessionId);
    return run;
  }

  resumeAll(sessionId) {
    const run = this.runs.get(sessionId);
    if (!run) return null;
    run.stoppedAll = false;
    run.error = null;
    if (run.circuitBreaker) {
      run.circuitBreaker = null;
      run.outerCycleCount = Math.max(1, Math.min(2, run.outerCycleCount));
      run.constructionReworkCount = 0;
    }
    for (const g of run.groups) {
      g.stopped = false;
      if (g.statusText === '已停止' || g.statusText === '本组已停止' || g.color === 'red') {
        g.color = 'neutral';
        g.statusText = '准备继续';
      }
    }
    for (const ind of run.independents) {
      if (ind.statusText === '已停止' || ind.color === 'red') {
        ind.color = 'neutral';
        ind.statusText = '准备继续';
      }
    }
    run.stageLabel = '正在恢复执行';
    this.emit(sessionId);
    return run;
  }

  consumeQueuedInstructions(run, { groupKey = null, participantId = null } = {}) {
    if (!run?.queue?.length) return '';
    const picked = [];
    for (const item of run.queue) {
      if (item.status !== 'queued') continue;
      const matchTarget =
        (item.selector === 'explicit' && participantId && item.targetId === participantId)
        || (item.selector !== 'explicit' && (!item.groupKey || item.groupKey === groupKey));
      if (matchTarget) {
        item.status = 'delivered';
        picked.push(item.text);
      }
    }
    if (!picked.length) return '';
    return `\n\n【用户补充指令】\n${picked.map((t, i) => `${i + 1}. ${t}`).join('\n')}`;
  }

  async enqueueInstruction(sessionId, { groupKey = null, selector = 'next', participantId = null, text = '' }) {
    const run = this.runs.get(sessionId);
    const clean = String(text || '').trim();
    if (!run || !clean) throw new Error('请输入补充指令内容');
    const item = {
      id: `inst-${crypto.randomUUID().slice(0, 8)}`,
      at: new Date().toISOString(),
      groupKey: groupKey || null,
      selector,
      targetId: participantId || 'next',
      status: 'queued',
      text: clean
    };
    run.queue.push(item);

    const targetChildIds = [];
    if (participantId) {
      for (const g of run.groups) if (g.childIds?.[participantId]) targetChildIds.push(g.childIds[participantId]);
      for (const ind of run.independents) if (ind.id === participantId && ind.nativeSessionId) targetChildIds.push(ind.nativeSessionId);
    } else if (groupKey) {
      const g = run.groups.find(item => item.key === groupKey || item.groupId === groupKey);
      if (g) targetChildIds.push(...Object.values(g.childIds ?? {}));
    }
    for (const cid of targetChildIds) {
      try { await this.runtime.sendGuidance(sessionId, cid, clean); item.status = 'delivered'; } catch {}
    }
    this.emit(sessionId);
    return item;
  }

  async runSecretaryReport(run, parentAgent, { kind = 'stage', stageSummary = '', details = '', customPrompt = null, signal }) {
    const secModel = run.secretary?.model;
    if (!secModel || run.stoppedAll) return null;
    run.secretary.color = 'yellow';
    run.secretary.status = 'running';
    run.secretary.error = null;
    this.emit(run.sessionId);

    try {
      const promptText = customPrompt || `【汇报类型】${kind === 'final' ? '全部工作结束后的最终总结报告' : '阶段进度汇报'}\n【当前进展】${stageSummary}\n【成果详情】\n${String(details)}\n\n请使用平实通顺的简体中文直接输出汇报内容，完整保留各工作组核心成果、关键技术参数与审验结论，不要输出空泛免责声明。`;
      const res = await this.runtime.runSeatTurn({
        rootAgent: parentAgent,
        existingChildId: run.secretary.nativeSessionId,
        name: 'cabinet-secretary',
        label: run.secretary.label,
        role: 'secretary',
        roleBadge: '内阁秘书',
        seatLabel: secModel.shortLabel,
        taskId: run.taskId,
        model: secModel,
        allowWrite: false,
        prompt: promptText,
        signal
      });
      run.secretary.nativeSessionId = res.childId;
      const brief = res.text || stageSummary;
      run.secretary.latestBrief = brief.split(/\r?\n/).find(l => l.trim())?.slice(0, 120) || stageSummary;
      run.secretary.reports.push({
        id: `rep-${crypto.randomUUID().slice(0, 8)}`,
        kind,
        at: new Date().toISOString(),
        text: brief
      });
      if (kind === 'final' && parentAgent) {
        await this.runtime.appendMainAssistantMessage(parentAgent, {
          taskId: run.taskId,
          actorLabel: run.secretary.label,
          groupLabel: '秘书',
          title: `秘书 · ${secModel.shortLabel}`,
          role: 'secretary',
          participantId: 'secretary',
          providerId: secModel.providerId,
          modelId: secModel.modelId,
          phase: 'secretary-final',
          text: brief
        });
      }
      run.secretary.color = 'green';
      run.secretary.status = 'completed';
      this.emit(run.sessionId);
      return brief;
    } catch (err) {
      if (err.message === 'TASK_STOPPED' || signal?.aborted) {
        run.secretary.color = 'neutral';
        run.secretary.status = 'stopped';
      } else {
        run.secretary.color = 'red';
        run.secretary.status = 'failed';
        run.secretary.error = err.message;
        run.secretary.latestBrief = '';
      }
      this.emit(run.sessionId);
      if (kind === 'final' || kind === 'blueprint') throw err;
      return null;
    }
  }

  _resolveRoleActors(run, role, reviewTarget = null) {
    const hasConstruction =
      run.groups.some(g => g.role === 'construction')
      || run.independents.some(i => i.role === 'construction');

    const matchesReviewTarget = (targets) => {
      if (role !== 'review' || !reviewTarget) return true;
      // 若整个内阁无施工席，所有审验席在设计审验阶段均参与纯方案审验
      if (!hasConstruction && reviewTarget === 'design') return true;
      const arr = Array.isArray(targets) && targets.length ? targets : ['design', 'construction'];
      return arr.includes(reviewTarget);
    };

    const group = run.groups.find(g => g.role === role) || null;
    const inds = run.independents.filter(i => i.role === role && matchesReviewTarget(i.reviewTargets));

    const workers = [];
    let leader = null;

    if (group) {
      for (const m of group.members) {
        const seat = run.config.seats.find(s => s.id === m.id);
        if (!seat) continue;
        if (m.kind === 'leader') {
          leader = { type: 'group-leader', group, member: m, seat };
        } else if (matchesReviewTarget(m.reviewTargets)) {
          workers.push({ type: 'group-member', group, member: m, seat });
        }
      }
    }

    for (const ind of inds) {
      const seat = run.config.seats.find(s => s.id === ind.id);
      if (!seat) continue;
      workers.push({ type: 'independent', ind, seat });
    }

    return { group, inds, workers, leader, hasConstruction };
  }

  async _callActor(run, parentAgent, actor, { stageTitle, prompt, allowWrite = false, ownedPaths = null, outputSchema = undefined, taskSignal }) {
    taskSignal?.throwIfAborted?.();
    if (run.stoppedAll || (actor.group && actor.group.stopped)) throw new Error('TASK_STOPPED');

    const { seat } = actor;
    if (actor.type === 'group-member' || actor.type === 'group-leader') {
      const { group, member } = actor;
      member.color = 'yellow';
      member.statusText = `${stageTitle}中`;
      group.color = 'yellow';
      group.statusText = `${stageTitle} · ${seat.label}`;
      this.emit(run.sessionId);

      const existingChildId = group.childIds?.[seat.id] ?? null;
      const extraGuidance = this.consumeQueuedInstructions(run, { groupKey: group.key, participantId: seat.id });
      const res = await this.runtime.runSeatTurn({
        rootAgent: parentAgent,
        existingChildId,
        name: safeAgentSlug(`${group.role}-${seat.label}-${seat.id.slice(-4)}`),
        label: `${group.label} · ${seat.label}`,
        role: group.role,
        roleBadge: member.roleBadge,
        seatLabel: seat.label,
        taskId: run.taskId,
        model: seat.model,
        prompt: `${prompt}${extraGuidance}`,
        allowWrite,
        ownedPaths,
        outputSchema,
        signal: taskSignal
      });
      if (!existingChildId || outputSchema === undefined) {
        group.childIds[seat.id] = res.childId;
        member.nativeSessionId = res.childId;
      }
      member.color = 'green';
      member.statusText = '已提交成果';
      this.emit(run.sessionId);
      return res;
    }

    const { ind } = actor;
    ind.color = 'yellow';
    ind.statusText = `${stageTitle}中`;
    this.emit(run.sessionId);

    const extraGuidance = this.consumeQueuedInstructions(run, { participantId: seat.id });
    const res = await this.runtime.runSeatTurn({
      rootAgent: parentAgent,
      existingChildId: ind.nativeSessionId,
      name: safeAgentSlug(`ind-${ind.role}-${seat.label}-${seat.id.slice(-4)}`),
      label: ind.label,
      role: ind.role,
      roleBadge: `${ROLE_LABELS[ind.role]} · ${seat.label}`,
      seatLabel: seat.label,
      taskId: run.taskId,
      model: seat.model,
      prompt: `${prompt}${extraGuidance}`,
      allowWrite,
      ownedPaths,
      outputSchema,
      signal: taskSignal
    });
    if (!ind.nativeSessionId || outputSchema === undefined) {
      ind.nativeSessionId = res.childId;
    }
    ind.outputText = res.text;
    ind.color = 'green';
    ind.statusText = '已提交成果';
    this.emit(run.sessionId);
    return res;
  }

  _markActorFailed(run, actor, err) {
    const msg = err?.message || String(err);
    const seatId = actor.seat.id;
    run.seatErrors[seatId] = msg;
    if (actor.type === 'independent') {
      actor.ind.color = 'red';
      actor.ind.statusText = `执行出错：${msg}`;
    } else {
      actor.member.color = 'red';
      actor.member.statusText = `执行出错：${msg}`;
      actor.group.color = 'red';
      actor.group.statusText = `「${actor.seat.label}」执行出错`;
    }
    this.emit(run.sessionId);
  }

  // 席位级结果缓存：同模型+同档位+同提示词的席位成果直接沿用，断点续跑只重跑失败或被改动的席位
  async _cachedCall(run, parentAgent, actor, opts) {
    const cache = this._cacheOf(run.sessionId);
    const key = crypto.createHash('sha1')
      .update([actor.seat.id, opts.stageTitle, this._seatSig(actor.seat), opts.prompt].join('\u0001'))
      .digest('hex');
    const hit = cache.get(key);
    if (hit) {
      if (actor.type === 'independent') {
        actor.ind.color = 'green';
        actor.ind.statusText = '已提交成果（沿用）';
      } else {
        actor.member.color = 'green';
        actor.member.statusText = '已提交成果（沿用）';
      }
      delete run.seatErrors[actor.seat.id];
      this.emit(run.sessionId);
      return hit;
    }
    try {
      const res = await this._callActor(run, parentAgent, actor, opts);
      cache.set(key, res);
      delete run.seatErrors[actor.seat.id];
      return res;
    } catch (err) {
      if (err?.message !== 'TASK_STOPPED' && !run.stoppedAll) {
        this._markActorFailed(run, actor, err);
        throw Object.assign(new Error(`「${actor.seat.label}」：${err?.message || String(err)}`), { code: err?.code });
      }
      throw err;
    }
  }

  // 并行执行并等全部落定：已成功席位成果进缓存，失败席位已标红，整体抛出中断
  async _awaitAll(run, promises) {
    const settled = await Promise.allSettled(promises);
    const values = [];
    const fails = [];
    for (const s of settled) {
      if (s.status === 'fulfilled') values.push(s.value);
      else fails.push(s.reason);
    }
    if (!fails.length) return values;
    if (fails.some(e => e?.message === 'TASK_STOPPED') || run.stoppedAll) throw new Error('TASK_STOPPED');
    const detail = fails.map(e => e?.message || String(e)).join('；');
    throw Object.assign(new Error(`${fails.length} 个席位执行失败（${detail}）。其余席位成果已保留，可在「配置」中调整后继续。`), { code: 'SEAT_FAILURES' });
  }

  _collectQuickJumpSessions(run) {
    const list = [];
    for (const g of run.groups) {
      for (const m of g.members) {
        const cid = m.nativeSessionId || g.childIds?.[m.id] || null;
        if (cid) {
          list.push({
            role: g.role,
            groupLabel: g.label,
            seatId: m.id,
            label: `${g.label} · ${m.label}（${m.roleBadge}）`,
            sessionId: cid
          });
        }
      }
    }
    for (const ind of run.independents) {
      if (ind.nativeSessionId) {
        list.push({
          role: ind.role,
          groupLabel: ROLE_LABELS[ind.role] || ind.role,
          seatId: ind.id,
          label: ind.label,
          sessionId: ind.nativeSessionId
        });
      }
    }
    if (run.secretary?.nativeSessionId) {
      list.push({
        role: 'secretary',
        groupLabel: '秘书',
        seatId: 'secretary',
        label: run.secretary.label,
        sessionId: run.secretary.nativeSessionId
      });
    }
    return list;
  }

  async _triggerCircuitBreaker(run, parentAgent, { phase, reason }) {
    run.stage = 'circuit-broken';
    run.lifecycle = 'interrupted';
    const phaseName = phase === 'design-review' ? '设计审验' : '施工审验';
    run.stageLabel = `${phaseName}连续未通过 · 已触发三次熔断暂停`;
    run.error = reason;
    const sessions = this._collectQuickJumpSessions(run);
    run.circuitBreaker = {
      triggered: true,
      phase,
      phaseName,
      outerCycleCount: run.outerCycleCount,
      constructionReworkCount: run.constructionReworkCount,
      title: `${phaseName}连续未通过 · 请人工介入排障`,
      reason,
      history: [...run.rejectionHistory],
      sessions,
      at: new Date().toISOString()
    };

    if (parentAgent) {
      const historyLines = run.rejectionHistory.map((h, i) =>
        `${i + 1}. [第 ${h.cycle} 轮${h.rework ? ` / 施工返工 #${h.rework}` : ''} · ${h.phase === 'design-review' ? '设计审验' : '施工审验'}] ${h.summary}`
      ).join('\n\n');
      await this.runtime.appendMainAssistantMessage(parentAgent, {
        taskId: run.taskId,
        actorLabel: '内阁熔断保护',
        groupLabel: '三次审验未通过 · 人工介入',
        title: `${phaseName}触发三次熔断保护 · 等待人工介入`,
        role: 'review',
        phase: 'cabinet-blocked',
        text: `内阁在「${phaseName}」阶段已达 3 次退回上限，流程已暂停并弹出排障窗口。\n\n【最新未通过原因】\n${reason}\n\n【历次退回记录】\n${historyLines}\n\n请通过弹窗或右侧内阁面板直接打开设计组、施工组或审验组子会话查看详情。`
      });
    }
    this.emit(run.sessionId);
    return run;
  }

  async initBoardTasks(run, parentAgent) {
    if (!parentAgent) return;
    await this.runtime.ensureTeamEnabled(parentAgent);
    if (!run.boardTaskIds) run.boardTaskIds = {};
    const dActors = this._resolveRoleActors(run, 'design');
    const drActors = this._resolveRoleActors(run, 'review', 'design');
    const cActors = this._resolveRoleActors(run, 'construction');
    const crActors = this._resolveRoleActors(run, 'review', 'construction');

    let prevIds = [];
    const addLayer = async (phaseKey, subjectPrefix, units, desc) => {
      const ids = [];
      for (const u of units) {
        const slotKey = `${phaseKey}::${u.key}`;
        let tid = run.boardTaskIds[slotKey];
        if (!tid) {
          const t = await this.runtime.createBoardTask(parentAgent, {
            subject: subjectPrefix ? `${subjectPrefix} · ${u.label}` : u.label,
            description: desc,
            blockedBy: prevIds
          });
          if (t?.id) {
            tid = t.id;
            run.boardTaskIds[slotKey] = tid;
            if (!u.boardTaskId) u.boardTaskId = tid;
          }
        }
        if (tid) ids.push(tid);
      }
      if (ids.length) prevIds = ids;
    };

    const unitsOf = (actors) => [...(actors.group ? [actors.group] : []), ...actors.inds];
    await addLayer('design', '', unitsOf(dActors), '设计阶段：平行盲写制定方案与接口契约');
    await addLayer('design-review', '设计审验', unitsOf(drActors), '设计审验：一对一盲审与一票否决核查');
    if (cActors.hasConstruction) {
      await addLayer('construction', '', unitsOf(cActors), '施工阶段：按唯一施工蓝图执行单写或分片施工');
      await addLayer('construction-review', '施工审验', unitsOf(crActors), '施工审验：基于工作区真实实证包独立盲审');
    }
  }

  boardTaskIdFor(run, phaseKey, unit) {
    if (!unit) return null;
    return run.boardTaskIds?.[`${phaseKey}::${unit.key}`] ?? unit.boardTaskId ?? null;
  }

  async _runDesignStage(run, parentAgent, { dActors, taskPrompt, feedback, cycle, taskSignal }) {
    run.stage = 'design';
    run.stageLabel = cycle > 1 ? `设计方案修订（第 ${cycle}/3 轮）` : '设计方案平行盲写中';
    this.emit(run.sessionId);

    const units = [...(dActors.group ? [dActors.group] : []), ...dActors.inds];
    for (const u of units) {
      const tid = this.boardTaskIdFor(run, 'design', u);
      if (tid) await this.runtime.updateBoardTask(parentAgent, tid, 'claim');
    }

    const constraintsBlock = run.config.constraints ? `\n【边界与约束】\n${run.config.constraints}` : '';
    const feedbackBlock = feedback ? `\n\n【前序审验退回修改意见（请务必针对性解决）】\n${feedback}` : '';
    const blindPrompt = `【当前阶段：设计方案制定（第 ${cycle} 轮 · 零干扰独立盲写）】\n【用户任务需求】\n${taskPrompt}${constraintsBlock}${feedbackBlock}\n\n请独立完成并输出你的完整设计方案（包含核心思路、模块/文件改动清单、关键接口与数据结构、边界处理及验证方式）。不要省略关键技术参数。`;

    // 所有设计组员/独立席零开场干扰，真并行盲写
    const proposals = await this._awaitAll(run,
      dActors.workers.map(async (worker, idx) => {
        const res = await this._cachedCall(run, parentAgent, worker, {
          stageTitle: '设计盲写',
          prompt: blindPrompt,
          allowWrite: false,
          taskSignal
        });
        return {
          index: idx + 1,
          seatId: worker.seat.id,
          seatLabel: worker.seat.label,
          text: res.text
        };
      })
    );

    run.designProposals = proposals;

    // 路线 B：若无施工席且设有设计组长，由设计组长在组员盲写完成后输出面向用户的简报概要（不干预组员原稿）
    let leaderBrief = '';
    if (!dActors.hasConstruction && dActors.leader) {
      const rawBundle = proposals.map(p => `### 方案 #${p.index}（${p.seatLabel}）\n${p.text}`).join('\n\n---\n\n');
      const briefRes = await this._callActor(run, parentAgent, dActors.leader, {
        stageTitle: '设计简报汇总',
        prompt: `【当前阶段：设计组长简报概要】\n【用户任务需求】\n${taskPrompt}\n\n以下是本组各设计席独立盲写完成的方案原稿：\n\n${rawBundle}\n\n请作为设计组长，面向用户输出一份简明清晰的《设计方案对比与汇总简报》，提炼各方案的核心亮点、异同点与建议，并完整保留关键技术细节。`,
        allowWrite: false,
        taskSignal
      });
      leaderBrief = briefRes.text;
    }

    const combinedText = proposals.length === 1
      ? proposals[0].text
      : [
          ...(leaderBrief ? [`## 设计组长简报概要（${dActors.leader.seat.label}）\n${leaderBrief}`] : []),
          ...proposals.map(p => `## 设计提案 #${p.index}（${p.seatLabel}）\n${p.text}`)
        ].join('\n\n---\n\n');

    if (dActors.group) {
      dActors.group.formalText = combinedText;
      dActors.group.formalVersion = `design-v${cycle}`;
      dActors.group.color = 'green';
      dActors.group.statusText = '设计提案已就绪';
    }
    for (const u of units) {
      const tid = this.boardTaskIdFor(run, 'design', u);
      if (tid) await this.runtime.updateBoardTask(parentAgent, tid, 'complete');
    }

    run.designArtifact = {
      version: `design-v${cycle}`,
      text: combinedText,
      proposals,
      leaderBrief,
      approved: false
    };
    this.emit(run.sessionId);
    return { stopped: false, proposals, combinedText };
  }

  async _runDesignReviewStage(run, parentAgent, { drActors, taskPrompt, proposals, combinedText, cycle, taskSignal }) {
    run.stage = 'design-review';
    run.stageLabel = `设计审验中（第 ${cycle}/3 轮）`;
    this.emit(run.sessionId);

    const units = [...(drActors.group ? [drActors.group] : []), ...drActors.inds];
    for (const u of units) {
      const tid = this.boardTaskIdFor(run, 'design-review', u);
      if (tid) await this.runtime.updateBoardTask(parentAgent, tid, 'claim');
    }

    const isPairedBlind = proposals.length >= 2 && drActors.workers.length >= 2;
    const workerVerdicts = await this._awaitAll(run, 
      drActors.workers.map(async (reviewer, idx) => {
        let targetHeader;
        let targetBody;
        let pairedProposal = null;
        if (isPairedBlind && drActors.workers.length >= proposals.length) {
          pairedProposal = proposals[idx % proposals.length];
          targetHeader = `【一对一匿名盲审对象：待审设计提案 #${pairedProposal.index}】`;
          targetBody = pairedProposal.text;
        } else {
          targetHeader = `【待审设计方案（共 ${proposals.length} 份）】`;
          targetBody = combinedText;
        }

        const rPrompt = `【当前阶段：设计方案盲审（第 ${cycle} 轮）】\n【用户任务需求】\n${taskPrompt}\n\n${targetHeader}\n${targetBody}\n\n请基于用户任务需求与工程可行性独立审验以上设计方案（你可使用只读文件工具查阅相关源码，也可使用只读 Shell 执行查询命令，但严禁修改任何文件）。\n若方案完整可行、无实质阻断缺陷，请判 pass；若存在架构硬伤、需求遗漏或逻辑错误，请判 changes 并列明具体修改要求。`;

        const res = await this._cachedCall(run, parentAgent, reviewer, {
          stageTitle: isPairedBlind ? `一对一盲审 #${(idx % proposals.length) + 1}` : '设计盲审',
          prompt: rPrompt,
          allowWrite: false,
          outputSchema: DESIGN_REVIEW_OUTPUT_SCHEMA,
          taskSignal
        });
        const conclusion = res.structured?.conclusion === 'changes' ? 'changes' : 'pass';
        const summary = res.structured?.summary || res.text || '';
        if (reviewer.type === 'independent') reviewer.ind.reviewConclusion = conclusion;
        return {
          reviewerId: reviewer.seat.id,
          reviewerLabel: reviewer.seat.label,
          pairedProposalIndex: pairedProposal ? pairedProposal.index : null,
          pairedDesignLabel: pairedProposal ? pairedProposal.seatLabel : null,
          conclusion,
          summary
        };
      })
    );

    // 纯代码一票否决裁定
    const rejectedVerdicts = workerVerdicts.filter(v => v.conclusion === 'changes');
    const approved = rejectedVerdicts.length === 0;

    // 路线 B：若有审验组长，组长仅做去重归类简报概要，不推翻组员的一票否决结论
    let leaderSummary = '';
    if (drActors.leader) {
      const rawVerdictsText = workerVerdicts.map((v, i) => {
        const pairTag = v.pairedProposalIndex ? `（对应提案 #${v.pairedProposalIndex} · ${v.pairedDesignLabel}）` : '';
        return `### 审验席 #${i + 1}（${v.reviewerLabel}）${pairTag}：${v.conclusion === 'pass' ? '通过 (pass)' : '退回 (changes)'}\n${v.summary}`;
      }).join('\n\n');

      const lRes = await this._callActor(run, parentAgent, drActors.leader, {
        stageTitle: '审验简报整理',
        prompt: `【当前阶段：审验组长简报概要（一票否决制已判定本轮结果为：${approved ? '全部通过' : '不通过 / 退回修改'}）】\n【用户任务需求】\n${taskPrompt}\n\n以下是本组各审验席独立盲审的意见明细：\n\n${rawVerdictsText}\n\n请作为审验组长，对以上审验意见进行去重、归类与提炼，输出一份清晰精炼的《设计审验简报》（不得更改各审验员的通过/退回结论）。`,
        allowWrite: false,
        taskSignal
      });
      leaderSummary = lRes.text;
    }

    const fullReviewReport = [
      ...(leaderSummary ? [`【审验组长简报（${drActors.leader.seat.label}）】\n${leaderSummary}`] : []),
      ...workerVerdicts.map((v, i) => {
        const pairTag = v.pairedProposalIndex ? ` -> 审验提案 #${v.pairedProposalIndex}（${v.pairedDesignLabel}）` : '';
        return `【审验员 ${v.reviewerLabel}${pairTag}：${v.conclusion === 'pass' ? '明确通过' : '一票否决退回'}】\n${v.summary}`;
      })
    ].join('\n\n');

    if (drActors.group) {
      drActors.group.reviewConclusion = approved ? 'pass' : 'changes';
      drActors.group.formalText = fullReviewReport;
      drActors.group.formalVersion = `design-review-v${cycle}`;
      drActors.group.color = approved ? 'green' : 'red';
      drActors.group.statusText = approved ? '设计审验通过' : '一票否决 · 退回修改';
    }

    for (const u of units) {
      const tid = this.boardTaskIdFor(run, 'design-review', u);
      if (tid) await this.runtime.updateBoardTask(parentAgent, tid, 'complete');
    }

    this.emit(run.sessionId);
    const rejectionFeedback = rejectedVerdicts.length
      ? [
          ...(leaderSummary ? [`【审验组长归类简报】\n${leaderSummary}`] : []),
          ...rejectedVerdicts.map(v => {
            const pairTag = v.pairedProposalIndex ? `（针对提案 #${v.pairedProposalIndex} · ${v.pairedDesignLabel}）` : '';
            return `- [${v.reviewerLabel}${pairTag}]：${v.summary}`;
          })
        ].join('\n\n')
      : '';

    return {
      stopped: false,
      approved,
      workerVerdicts,
      leaderSummary,
      fullReviewReport,
      rejectionFeedback
    };
  }

  async _synthesizeConstructionBlueprint(run, parentAgent, { dActors, taskPrompt, proposals, reviewReport, cycle, taskSignal }) {
    if (proposals.length <= 1) {
      return proposals[0]?.text || run.designArtifact?.text || '';
    }

    const rawProposalsText = proposals.map(p => `### 过审设计提案 #${p.index}（${p.seatLabel}）\n${p.text}`).join('\n\n---\n\n');
    const synthPrompt = `【当前阶段：唯一《施工蓝图》合稿定稿（第 ${cycle} 轮）】\n【用户任务需求】\n${taskPrompt}\n\n【全部过审设计提案原稿】\n${rawProposalsText}\n\n【设计审验组核查意见】\n${reviewReport || '全部通过'}\n\n请取长补短，将以上各设计提案中的优秀设计整合为**唯一一份直接供施工席执行的《施工蓝图》**。\n要求：\n1. 开篇先列出简明的《方案取舍与关键参数对照表》，标明采纳了哪份提案的哪些部分、舍弃了哪些不合理部分；\n2. 正文给出统一的模块改动清单、文件路径、函数/接口签名与具体实现步骤，严禁丢失原稿中的关键技术参数与边界约束。`;

    // 1. 经典 9 席（或配了设计组长的模式）：由设计组长合稿生成唯一《施工蓝图》交付施工组
    if (dActors.leader) {
      run.stage = 'design-synthesis';
      run.stageLabel = `设计组长（${dActors.leader.seat.label}）正在合稿唯一《施工蓝图》`;
      this.emit(run.sessionId);

      const res = await this._callActor(run, parentAgent, dActors.leader, {
        stageTitle: '合稿唯一施工蓝图',
        prompt: synthPrompt,
        allowWrite: false,
        taskSignal
      });
      if (dActors.group) {
        dActors.group.formalText = res.text;
        dActors.group.statusText = '唯一《施工蓝图》已交付施工组';
      }
      this.emit(run.sessionId);
      return res.text;
    }

    // 2. 六国大封相（无设计组长，但配有秘书席）：由秘书席兼任合稿唯一《施工蓝图》
    if (run.secretary?.model) {
      run.stage = 'design-synthesis';
      run.stageLabel = `秘书席（${run.secretary.model.shortLabel}）正在兼任合稿唯一《施工蓝图》`;
      this.emit(run.sessionId);

      const blueprint = await this.runSecretaryReport(run, parentAgent, {
        kind: 'blueprint',
        stageSummary: '已合稿生成唯一《施工蓝图》并转交施工席。',
        customPrompt: synthPrompt,
        signal: taskSignal
      });
      if (blueprint) return blueprint;
    }

    // 3. 兜底：纯代码结构化无损打包
    return proposals.map(p => `## 过审设计方案 #${p.index}（${p.seatLabel}）\n${p.text}`).join('\n\n---\n\n');
  }

  async _runConstructionStage(run, parentAgent, { cActors, blueprintText, feedback, cycle, rework, taskSignal }) {
    run.stage = 'construction';
    const execMode = run.config.policies?.constructionExecutionMode === 'sequential' ? 'sequential' : 'parallel';
    const modeTag = cActors.workers.length >= 2 ? (execMode === 'sequential' ? '顺序分片施工' : '并行分片施工') : '单席直施';
    run.stageLabel = rework > 0
      ? `施工返工（第 ${rework}/3 次局部返工 · ${modeTag}）`
      : `工程施工中（${modeTag}）`;
    this.emit(run.sessionId);

    const units = [...(cActors.group ? [cActors.group] : []), ...cActors.inds];
    for (const u of units) {
      const tid = this.boardTaskIdFor(run, 'construction', u);
      if (tid) await this.runtime.updateBoardTask(parentAgent, tid, 'claim');
    }

    const snapKey = `c${cycle}-r${rework}`;
    const beforeSnap = (run.snapCache[snapKey] ??= this.runtime.captureWorkspaceSnapshot(parentAgent));
    const taskPrompt = run.taskGoalText || run.originalUserMessage || '按设计蓝图执行施工';
    const feedbackBlock = feedback ? `\n\n【施工审验退回返工要求（第 ${rework}/3 次返工，请立即修复）】\n${feedback}` : '';

    let buildSummaryText = '';

    // 情况 A：单席直施（1 个施工席，无组长）
    if (!cActors.leader && cActors.workers.length === 1) {
      const singleWorker = cActors.workers[0];
      const prompt = `【当前阶段：单席直施${rework > 0 ? `（第 ${rework}/3 次返工）` : ''}】\n【用户任务需求】\n${taskPrompt}\n\n【已认可唯一施工蓝图】\n${blueprintText}${feedbackBlock}\n\n请严格按照以上施工蓝图直接落盘修改代码或创建产物，并在完成后运行必要的语法/测试验证，最后输出清晰的施工改动摘要。`;
      const res = await this._cachedCall(run, parentAgent, singleWorker, {
        stageTitle: rework > 0 ? `返工 #${rework}` : '单席直施',
        prompt,
        allowWrite: true,
        ownedPaths: null,
        taskSignal
      });
      buildSummaryText = res.text;
    } else if (cActors.leader && cActors.workers.length >= 2) {
      // 情况 B：≥ 3 席施工组（1 位施工组长分片划区 + ≥ 2 位施工组员并行或顺序施工 + 组长收口）
      const memberRoster = cActors.workers.map(w => `- memberId: "${w.seat.id}"（名称：${w.seat.label}）`).join('\n');
      const planPrompt = `【当前阶段：施工组长分片划区${rework > 0 ? `（第 ${rework}/3 次返工）` : ''}】\n【用户任务需求】\n${taskPrompt}\n\n【已认可唯一施工蓝图】\n${blueprintText}${feedbackBlock}\n\n【本组可用施工组员名单】\n${memberRoster}\n\n请作为施工组长（当前处于只读分片规划阶段），将上述施工蓝图拆解为互不冲突的分片子任务，为每位施工组员指定专属的 memberId、具体施工任务 task，以及该组员允许修改的文件或目录相对路径白名单 ownedPaths（不同组员的 ownedPaths 严禁重叠；若某组员负责特定文件请精确列出相对路径）。`;

      const planRes = await this._cachedCall(run, parentAgent, cActors.leader, {
        stageTitle: '组长分片划区',
        prompt: planPrompt,
        allowWrite: false,
        outputSchema: CONSTRUCTION_SHARD_SCHEMA,
        taskSignal
      });

      const structuredShards = Array.isArray(planRes.structured?.shards) ? planRes.structured.shards : [];
      const integrationNotes = planRes.structured?.integrationNotes || planRes.text || '';

      const resolveShardForWorker = (worker, idx) => {
        const found = structuredShards.find(s => s.memberId === worker.seat.id || s.memberId === worker.seat.label)
          || structuredShards[idx];
        return {
          task: found?.task || `负责施工蓝图中与席位 ${worker.seat.label}（分片 #${idx + 1}）对应的模块实现。`,
          ownedPaths: Array.isArray(found?.ownedPaths) && found.ownedPaths.length ? found.ownedPaths : ['*']
        };
      };

      const shardOutputs = [];
      if (execMode === 'parallel') {
        const results = await this._awaitAll(run,
          cActors.workers.map(async (worker, idx) => {
            const shard = resolveShardForWorker(worker, idx);
            const wPrompt = `【当前阶段：分片并行施工 · 分片 #${idx + 1}（${worker.seat.label}）】\n【用户任务需求】\n${taskPrompt}\n\n【施工组长分派给你的专属子任务】\n${shard.task}\n\n【你被授权修改的专属路径白名单】\n${shard.ownedPaths.join(', ')}\n\n【跨分片公共接口约定】\n${integrationNotes}\n\n【完整施工蓝图参考】\n${blueprintText}${feedbackBlock}\n\n请严格在你被授权的路径白名单内完成代码编写或修改，完成后输出你的分片施工完成摘要。`;
            const res = await this._cachedCall(run, parentAgent, worker, {
              stageTitle: `并行施工 (${shard.ownedPaths[0] || '分片'})`,
              prompt: wPrompt,
              allowWrite: true,
              ownedPaths: shard.ownedPaths,
              taskSignal
            });
            return `### 分片 #${idx + 1}（${worker.seat.label} · 路径: ${shard.ownedPaths.join(', ')}）\n${res.text}`;
          })
        );
        shardOutputs.push(...results);
      } else {
        for (let idx = 0; idx < cActors.workers.length; idx++) {
          const worker = cActors.workers[idx];
          const shard = resolveShardForWorker(worker, idx);
          const prevContext = shardOutputs.length
            ? `\n\n【前序分片已完成的施工摘要】\n${shardOutputs.join('\n\n')}`
            : '';
          const wPrompt = `【当前阶段：分片顺序施工 · 第 ${idx + 1}/${cActors.workers.length} 棒（${worker.seat.label}）】\n【用户任务需求】\n${taskPrompt}\n\n【施工组长分派给你的专属子任务】\n${shard.task}\n\n【你被授权修改的专属路径白名单】\n${shard.ownedPaths.join(', ')}\n\n【跨分片公共接口约定】\n${integrationNotes}${prevContext}\n\n【完整施工蓝图参考】\n${blueprintText}${feedbackBlock}\n\n请严格在你被授权的路径白名单内完成施工，并输出本棒完成摘要。`;
          const res = await this._cachedCall(run, parentAgent, worker, {
            stageTitle: `顺序施工 #${idx + 1}`,
            prompt: wPrompt,
            allowWrite: true,
            ownedPaths: shard.ownedPaths,
            taskSignal
          });
          shardOutputs.push(`### 分片 #${idx + 1}（${worker.seat.label} · 路径: ${shard.ownedPaths.join(', ')}）\n${res.text}`);
        }
      }

      // 施工组长收口集成
      const finalizePrompt = `【当前阶段：施工组长收口集成与自检】\n【用户任务需求】\n${taskPrompt}\n\n【各施工组员分片执行结果】\n${shardOutputs.join('\n\n')}\n\n请作为施工组长核查各分片衔接情况，必要时做跨分片收口修正并运行验证命令，最后输出施工组整体交付报告。`;
      const finalRes = await this._callActor(run, parentAgent, cActors.leader, {
        stageTitle: '施工组长收口',
        prompt: finalizePrompt,
        allowWrite: true,
        ownedPaths: null,
        taskSignal
      });
      buildSummaryText = [
        `## 施工组长收口报告（${cActors.leader.seat.label}）\n${finalRes.text}`,
        ...shardOutputs
      ].join('\n\n---\n\n');
    }

    const evidence = this.runtime.collectConstructionEvidence(parentAgent, beforeSnap);
    if (cActors.group) {
      cActors.group.formalText = buildSummaryText;
      cActors.group.formalVersion = `build-c${cycle}-r${rework}`;
      cActors.group.color = 'green';
      cActors.group.statusText = '施工完成 · 已移交实证审验';
    }
    for (const u of units) {
      const tid = this.boardTaskIdFor(run, 'construction', u);
      if (tid) await this.runtime.updateBoardTask(parentAgent, tid, 'complete');
    }

    run.constructionArtifact = {
      version: `build-c${cycle}-r${rework}`,
      text: buildSummaryText,
      evidenceText: evidence.evidenceText,
      changed: evidence.changed
    };
    this.emit(run.sessionId);
    return { stopped: false, buildSummaryText, evidence };
  }

  async _runConstructionReviewStage(run, parentAgent, { crActors, taskPrompt, blueprintText, buildSummaryText, evidence, cycle, rework, taskSignal }) {
    run.stage = 'construction-review';
    run.stageLabel = rework > 0
      ? `施工返工审验中（第 ${rework}/3 次返工核查）`
      : `施工实证审验中（第 ${cycle}/3 轮）`;
    this.emit(run.sessionId);

    const units = [...(crActors.group ? [crActors.group] : []), ...crActors.inds];
    for (const u of units) {
      const tid = this.boardTaskIdFor(run, 'construction-review', u);
      if (tid) await this.runtime.updateBoardTask(parentAgent, tid, 'claim');
    }

    const reviewPrompt = `【当前阶段：施工工程实证盲审（一票否决制）】\n【用户任务需求】\n${taskPrompt}\n\n【已认可唯一施工蓝图】\n${blueprintText}\n\n【施工席交付说明】\n${buildSummaryText}\n\n${evidence.evidenceText}\n\n请基于以上【工作区真实工程实证包】与【施工蓝图】进行严格工程验收（你可以调用只读文件工具查阅全仓任何源码，也可以调用 Shell 运行只读编译、语法检查或测试命令来揪出深层隐患，但严禁通过任何命令写文件或修改 Git 状态）。\n判定规则：\n- 若代码/产物已真实落盘、符合设计蓝图且测试验证通过，请判 conclusion: "pass"；\n- 若存在笔误、漏改、语法报错、测试失败或与蓝图不符，请判 conclusion: "changes"，并将 rejectTarget 设为 "construction"（退回施工席返工）；\n- 若经核查发现是原设计蓝图本身存在底层方案硬伤导致无法施工或必然出错，请判 conclusion: "changes"，并将 rejectTarget 设为 "design"（升级打回设计组重出方案）。`;

    const workerVerdicts = await this._awaitAll(run,
      crActors.workers.map(async (reviewer) => {
        const res = await this._cachedCall(run, parentAgent, reviewer, {
          stageTitle: '施工实证盲审',
          prompt: reviewPrompt,
          allowWrite: false,
          outputSchema: CONSTRUCTION_REVIEW_OUTPUT_SCHEMA,
          taskSignal
        });
        const conclusion = res.structured?.conclusion === 'changes' ? 'changes' : 'pass';
        const rejectTarget = res.structured?.rejectTarget === 'design' ? 'design' : 'construction';
        const summary = res.structured?.summary || res.text || '';
        if (reviewer.type === 'independent') reviewer.ind.reviewConclusion = conclusion;
        return {
          reviewerId: reviewer.seat.id,
          reviewerLabel: reviewer.seat.label,
          conclusion,
          rejectTarget,
          summary
        };
      })
    );

    const rejectedVerdicts = workerVerdicts.filter(v => v.conclusion === 'changes');
    const approved = rejectedVerdicts.length === 0;
    const escalateToDesign = rejectedVerdicts.some(v => v.rejectTarget === 'design');

    // 路线 B：若有审验组长，生成去重归类的《施工审验简报》，不推翻一票否决结论
    let leaderSummary = '';
    if (crActors.leader) {
      const rawVerdictsText = workerVerdicts.map((v, i) =>
        `### 审验席 #${i + 1}（${v.reviewerLabel}）：${v.conclusion === 'pass' ? '通过 (pass)' : `一票否决退回 (${v.rejectTarget === 'design' ? '退回设计组' : '退回施工席'})`}\n${v.summary}`
      ).join('\n\n');

      const lRes = await this._callActor(run, parentAgent, crActors.leader, {
        stageTitle: '施工审验简报整理',
        prompt: `【当前阶段：审验组长施工审验简报（一票否决制已判定结果为：${approved ? '全部通过' : '未通过 / 退回返工'}）】\n以下是各审验员基于工作区真实实证包独立盲审的结果：\n\n${rawVerdictsText}\n\n请作为审验组长，对上述审验意见做去重归类与要点提炼，输出简明的《施工审验简报》（不得更改各审验员的通过/退回结论）。`,
        allowWrite: false,
        taskSignal
      });
      leaderSummary = lRes.text;
    }

    const fullReviewReport = [
      ...(leaderSummary ? [`【审验组长简报（${crActors.leader.seat.label}）】\n${leaderSummary}`] : []),
      ...workerVerdicts.map(v =>
        `【审验员 ${v.reviewerLabel}：${v.conclusion === 'pass' ? '明确通过' : `一票否决（退回${v.rejectTarget === 'design' ? '设计' : '施工'}）`}】\n${v.summary}`
      )
    ].join('\n\n');

    if (crActors.group) {
      crActors.group.reviewConclusion = approved ? 'pass' : 'changes';
      crActors.group.formalText = fullReviewReport;
      crActors.group.formalVersion = `build-review-c${cycle}-r${rework}`;
      crActors.group.color = approved ? 'green' : 'red';
      crActors.group.statusText = approved ? '施工审验通过' : '一票否决 · 退回返工';
    }

    for (const u of units) {
      const tid = this.boardTaskIdFor(run, 'construction-review', u);
      if (tid) await this.runtime.updateBoardTask(parentAgent, tid, 'complete');
    }

    this.emit(run.sessionId);
    const rejectionFeedback = rejectedVerdicts.length
      ? [
          ...(leaderSummary ? [`【审验组长归类简报】\n${leaderSummary}`] : []),
          ...rejectedVerdicts.map(v => `- [${v.reviewerLabel}]：${v.summary}`)
        ].join('\n\n')
      : '';

    return {
      stopped: false,
      approved,
      escalateToDesign,
      workerVerdicts,
      leaderSummary,
      fullReviewReport,
      rejectionFeedback
    };
  }

  async runTask(sessionId, parentAgent, userText = '') {
    const run = this.runs.get(sessionId);
    if (!run) return null;
    if (!run.originalUserMessage && String(userText || '').trim()) {
      run.originalUserMessage = String(userText).trim();
    }
    const taskPrompt = run.taskGoalText || run.originalUserMessage || '执行当前内阁任务';

    if (run.awaitingHumanApproval) {
      if (!/^(?:认可|认可此版|同意|通过|继续施工)$/.test(String(userText).trim())) return run;
      run.awaitingHumanApproval = false;
      run.humanApproved = true;
      if (run.designArtifact) run.designArtifact.approved = true;
    } else if (run.userAcceptanceStatus === 'awaiting-user' && /验收通过|确认验收/i.test(String(userText))) {
      run.userAcceptanceStatus = 'accepted';
      run.stage = 'accepted';
      run.stageLabel = '用户已确认验收';
      this.emit(sessionId);
      return run;
    }
    if (run.stoppedAll || run.lifecycle === 'ended') return run;

    const taskCtrl = new AbortController();
    this.taskControllers.set(sessionId, taskCtrl);
    const taskSignal = taskCtrl.signal;

    run.lifecycle = 'running';
    run.error = null;
    run.resumePending = false;
    this.emit(sessionId);

    try {
      await this.initBoardTasks(run, parentAgent);
      const dActors = this._resolveRoleActors(run, 'design');
      const drActors = this._resolveRoleActors(run, 'review', 'design');
      const cActors = this._resolveRoleActors(run, 'construction');
      const crActors = this._resolveRoleActors(run, 'review', 'construction');

      const hasDesignUnits = dActors.workers.length > 0;
      const hasDesignReviewUnits = drActors.workers.length > 0;
      const hasConstructionUnits = cActors.workers.length > 0;
      const hasConstructionReviewUnits = crActors.workers.length > 0;

      let designFeedback = run.designFeedback || '';

      // 外层整体循环（最多 3 轮，与施工组最多 3 次局部返工独立计数）
      while (run.outerCycleCount <= 3) {
        const cycle = run.outerCycleCount;

        // ==================== 第一阶段：设计 + 设计审验 ====================
        if (hasDesignUnits && !run.designArtifact?.approved) {
          const dRes = await this._runDesignStage(run, parentAgent, {
            dActors,
            taskPrompt,
            feedback: designFeedback,
            cycle,
            taskSignal
          });
          if (dRes.stopped || run.stoppedAll) return run;

          let latestDesignReviewReport = '';
          if (hasDesignReviewUnits) {
            const drRes = await this._runDesignReviewStage(run, parentAgent, {
              drActors,
              taskPrompt,
              proposals: dRes.proposals,
              combinedText: dRes.combinedText,
              cycle,
              taskSignal
            });
            if (drRes.stopped || run.stoppedAll) return run;
            latestDesignReviewReport = drRes.fullReviewReport;

            // 特例：「头脑风暴」模式 —— 审验不通过绝不触发打回重做，直接交由秘书席出具总结点评报告并完成交付
            if (run.config.presetMode === 'brainstorm') {
              run.stage = 'finalizing-delivery';
              run.stageLabel = '头脑风暴盲审完毕 · 秘书席正在汇总点评报告';
              this.emit(sessionId);

              const brainstormPrompt = `【当前阶段：头脑风暴终盘总结与方案点评报告】\n【用户任务需求】\n${taskPrompt}\n\n【4 份独立盲写设计方案原稿】\n${dRes.proposals.map(p => `### 设计方案 #${p.index}（${p.seatLabel}）\n${p.text}`).join('\n\n---\n\n')}\n\n【4 份一对一盲审结果与具体意见】\n${drRes.fullReviewReport}\n\n请作为内阁秘书，以结构化报告形式完整整理本次头脑风暴成果：\n1. 明确标明各设计席提交的方案是否通过一对一盲审（若存在未通过的设计方案，须清楚标明未通过席位及具体未通过原因）；\n2. 逐一点评 4 份设计方案的核心亮点、创新点与局限性；\n3. 综合审验意见给出最终推荐方案与落地建议。`;

              const finalReport = await this.runSecretaryReport(run, parentAgent, {
                kind: 'final',
                stageSummary: '头脑风暴 4 席设计盲写与 4 席一对一盲审已全部完成，现呈交总结点评报告。',
                customPrompt: brainstormPrompt,
                signal: taskSignal
              });

              run.deliverables.push({
                id: `deliv-${crypto.randomUUID().slice(0, 8)}`,
                version: `brainstorm-v${cycle}`,
                at: new Date().toISOString(),
                designText: finalReport || `${dRes.combinedText}\n\n---\n\n${drRes.fullReviewReport}`,
                constructionText: ''
              });
              run.stage = 'awaiting-user-acceptance';
              run.lifecycle = 'completed';
              run.stageLabel = '头脑风暴报告已交付主对话 · 已自动退回单模型';
              run.userAcceptanceStatus = 'awaiting-user';
              this.emit(sessionId);
              try { await this.onCompleted?.(sessionId); } catch {}
              return run;
            }

            if (!drRes.approved) {
              run.rejectionHistory.push({
                cycle,
                rework: 0,
                phase: 'design-review',
                target: 'design',
                summary: drRes.rejectionFeedback,
                at: new Date().toISOString()
              });

              if (run.outerCycleCount >= 3) {
                return await this._triggerCircuitBreaker(run, parentAgent, {
                  phase: 'design-review',
                  reason: drRes.rejectionFeedback
                });
              }

              designFeedback = drRes.rejectionFeedback;
              run.designFeedback = designFeedback;
              run.outerCycleCount += 1;
              await this.runSecretaryReport(run, parentAgent, {
                kind: 'stage',
                stageSummary: `第 ${cycle} 轮设计审验一票否决未通过，退回设计组进入第 ${run.outerCycleCount}/3 轮修订。`,
                details: designFeedback,
                signal: taskSignal
              });
              continue;
            }
          }

          // 设计审验已通过：若后续有施工席且存在多份设计提案，执行唯一《施工蓝图》合稿（经典9席由设计组长合稿，六国大封相由秘书席合稿）
          let finalBlueprintText = dRes.combinedText;
          if (hasConstructionUnits && dRes.proposals.length >= 2) {
            finalBlueprintText = await this._synthesizeConstructionBlueprint(run, parentAgent, {
              dActors,
              taskPrompt,
              proposals: dRes.proposals,
              reviewReport: latestDesignReviewReport,
              cycle,
              taskSignal
            });
          }

          run.designArtifact = {
            ...run.designArtifact,
            text: finalBlueprintText,
            approved: true
          };

          if (run.config.policies?.humanApprovalRequired === true && !run.humanApproved) {
            run.awaitingHumanApproval = true;
            run.lifecycle = 'interrupted';
            run.stage = 'awaiting-human-approval';
            run.stageLabel = '设计审验已通过 · 等待本人确认';
            this.emit(sessionId);
            return run;
          }
        }

        // ==================== 第二阶段：施工 + 施工实证审验 ====================
        if (hasConstructionUnits) {
          const blueprintText = run.designArtifact?.text || taskPrompt;
          let constructionFeedback = run.constructionFeedback || '';
          let constructionPassed = false;
          let shouldEscalateToDesign = false;
          let escalationReason = '';

          // 内层施工返工循环（最多 3 次局部返工：rework = 0 为首次施工，rework = 1, 2, 3 为最多三次返工）
          while (run.constructionReworkCount <= 3) {
            const rework = run.constructionReworkCount;
            const cRes = await this._runConstructionStage(run, parentAgent, {
              cActors,
              blueprintText,
              feedback: constructionFeedback,
              cycle,
              rework,
              taskSignal
            });
            if (cRes.stopped || run.stoppedAll) return run;

            if (!hasConstructionReviewUnits) {
              constructionPassed = true;
              break;
            }

            const crRes = await this._runConstructionReviewStage(run, parentAgent, {
              crActors,
              taskPrompt,
              blueprintText,
              buildSummaryText: cRes.buildSummaryText,
              evidence: cRes.evidence,
              cycle,
              rework,
              taskSignal
            });
            if (crRes.stopped || run.stoppedAll) return run;

            if (crRes.approved) {
              constructionPassed = true;
              break;
            }

            // 施工审验未通过（一票否决）
            const directToDesign = crRes.escalateToDesign && hasDesignUnits;
            run.rejectionHistory.push({
              cycle,
              rework,
              phase: 'construction-review',
              target: directToDesign || rework >= 3 ? 'design' : 'construction',
              summary: crRes.rejectionFeedback,
              at: new Date().toISOString()
            });

            if (!directToDesign && run.constructionReworkCount < 3) {
              // 笔误小错或局部实现问题：先退回施工席返工（最多 3 次，独立计数）
              run.constructionReworkCount += 1;
              constructionFeedback = crRes.rejectionFeedback;
              run.constructionFeedback = constructionFeedback;
              await this.runSecretaryReport(run, parentAgent, {
                kind: 'stage',
                stageSummary: `施工审验未通过，退回施工席进行第 ${run.constructionReworkCount}/3 次局部返工。`,
                details: constructionFeedback,
                signal: taskSignal
              });
              continue;
            }

            // 已连续 3 次施工返工仍未通过，或审验直接判定原设计有硬伤：准备升级退回设计组
            shouldEscalateToDesign = true;
            escalationReason = crRes.rejectionFeedback;
            break;
          }

          if (shouldEscalateToDesign) {
            // 若无设计席可退，或者外层大循环已达第 3 轮上限，则立即触发三次熔断保护
            if (!hasDesignUnits || run.outerCycleCount >= 3) {
              return await this._triggerCircuitBreaker(run, parentAgent, {
                phase: 'construction-review',
                reason: escalationReason
              });
            }

            // 升级打回设计组重出方案：重置施工返工计数器，外层循环 + 1
            run.constructionReworkCount = 0;
            if (run.designArtifact) run.designArtifact.approved = false;
            run.outerCycleCount += 1;
            designFeedback = `【施工阶段经 3 次返工仍无法通过审验，现退回设计组重新出具方案】\n${escalationReason}`;
            await this.runSecretaryReport(run, parentAgent, {
              kind: 'stage',
              stageSummary: `施工返工未解决问题，已升级退回设计组进入第 ${run.outerCycleCount}/3 轮重新设计。`,
              details: designFeedback,
              signal: taskSignal
            });
            continue;
          }

          if (constructionPassed) {
            break;
          }
        } else {
          // 纯设计模式且设计审验已通过
          break;
        }
      }

      // ==================== 第三阶段：最终交付主对话 ====================
      const finalDeliverable = {
        id: `deliv-${crypto.randomUUID().slice(0, 8)}`,
        version: run.constructionArtifact?.version || run.designArtifact?.version || 'v1',
        at: new Date().toISOString(),
        designText: run.designArtifact?.text || '',
        constructionText: run.constructionArtifact?.text || ''
      };
      run.deliverables.push(finalDeliverable);
      run.stage = 'finalizing-delivery';
      run.stageLabel = '正在完成主对话交付';
      this.emit(sessionId);

      const combinedFinalText = [finalDeliverable.designText, finalDeliverable.constructionText].filter(Boolean).join('\n\n---\n\n');
      if (run.secretary?.model) {
        await this.runSecretaryReport(run, parentAgent, {
          kind: 'final',
          stageSummary: '本轮全部工作组与审验均已通过，现呈交完整成果报告。',
          details: combinedFinalText,
          signal: taskSignal
        });
      } else if (parentAgent && combinedFinalText) {
        await this.runtime.appendMainAssistantMessage(parentAgent, {
          taskId: run.taskId,
          actorLabel: '内阁成果',
          groupLabel: '最终交付',
          title: '内阁最终交付成果',
          role: 'secretary',
          phase: 'final-delivery',
          text: combinedFinalText
        });
      }
      if (run.stoppedAll) return run;
      run.stage = 'awaiting-user-acceptance';
      run.lifecycle = 'completed';
      run.stageLabel = '已交付主对话 · 已自动退回单模型';
      run.userAcceptanceStatus = 'awaiting-user';
      this.emit(sessionId);
      try { await this.onCompleted?.(sessionId); } catch {}
      return run;
    } catch (err) {
      if (run.lifecycle !== 'ended') {
        run.lifecycle = 'interrupted';
      }
      if (!taskSignal.aborted && err.message !== 'TASK_STOPPED') {
        run.error = err.message;
        run.stageLabel = `执行受阻：${err.message}`;
        this.emit(sessionId);
      } else if (run.lifecycle === 'interrupted') {
        this.emit(sessionId);
      }
      return run;
    } finally {
      if (this.taskControllers.get(sessionId) === taskCtrl) this.taskControllers.delete(sessionId);
    }
  }
}
