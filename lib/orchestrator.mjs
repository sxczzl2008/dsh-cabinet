import crypto from 'node:crypto';
import { shortenModelName } from './model-catalog.mjs';

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

const REVIEW_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    conclusion: { type: 'string', enum: ['pass', 'changes'], description: '审验结论：pass 表示通过，changes 表示退回修改' },
    summary: { type: 'string', description: '审验结论摘要与具体意见（退回时必须列明具体修改要求）' }
  },
  required: ['conclusion', 'summary'],
  additionalProperties: false
});

export function resolveDiscussionRounds(raw = {}) {
  if (!Object.prototype.hasOwnProperty.call(raw, 'discussionRounds')) return 3;
  const rounds = raw.discussionRounds;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) {
    throw Object.assign(new Error('讨论轮数须为 1–5 的整数'), { code: 'INVALID_DISCUSSION_ROUNDS' });
  }
  return rounds;
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
    return null;
  };

  const rawSeats = Array.isArray(raw.seats) ? raw.seats : [];
  const seats = rawSeats.map((s, idx) => {
    const model = toModelRef(s.model);
    return {
      id: s.id || `seat-${idx + 1}`,
      label: s.label || model?.shortLabel || `席位${idx + 1}`,
      seatIndex: Number.isInteger(s.seatIndex) ? s.seatIndex : idx,
      inSeat: s.inSeat !== false,
      model,
      duties: Array.isArray(s.duties)
        ? s.duties.map(d => ({
            role: d.role,
            kind: d.kind || 'independent',
            groupId: d.kind && d.kind !== 'independent' ? (d.groupId || `${d.role}-group`) : undefined,
            groupName: d.kind && d.kind !== 'independent' ? (d.groupName || `${ROLE_LABELS[d.role] || d.role}组`) : undefined,
            ...(d.role === 'review' ? { reviewTargets: Array.isArray(d.reviewTargets) && d.reviewTargets.length ? d.reviewTargets : ['design', 'construction'] } : {})
          }))
        : []
    };
  });

  const secModel = toModelRef(raw.secretary?.model);
  const secretary = {
    id: 'secretary',
    model: secModel,
    label: secModel ? (raw.secretary?.label || secModel.shortLabel) : '秘书（未配置）'
  };

  const slotCount = Math.min(9, Math.max(1, Number.isInteger(raw.slotCount) ? raw.slotCount : Math.max(3, seats.length)));
  return {
    schemaVersion: 2,
    kind,
    id: raw.id || (kind === 'plan' ? 'default-cabinet-plan' : `task-${Date.now()}`),
    taskId: raw.taskId || raw.id || null,
    revision: Number.isInteger(raw.revision) ? raw.revision : 1,
    configVersion: Number.isInteger(raw.configVersion) ? raw.configVersion : 1,
    slotCount,
    discussionRounds: resolveDiscussionRounds(raw),
    goal: typeof raw.goal === 'string' ? raw.goal.trim() : '',
    constraints: typeof raw.constraints === 'string' ? raw.constraints.trim() : '',
    existingDesign: raw.existingDesign?.text ? { version: raw.existingDesign.version || 'v1', text: String(raw.existingDesign.text), approved: true } : null,
    secretary,
    seats,
    staging: Array.isArray(raw.staging) ? raw.staging : [],
    participants: seats.filter(s => s.inSeat && s.duties.length > 0).map(s => s.id),
    policies
  };
}

export function validateCabinetConfig(raw = {}, kind = 'task') {
  let normalized;
  try {
    normalized = normalizeConfig(raw, kind);
  } catch (err) {
    return { ok: false, value: null, errors: [{ code: err.code || 'INVALID_CONFIG', message: err.message }], groups: [] };
  }

  const errors = [];
  const activeSeats = normalized.seats.filter(s => s.inSeat);
  if (!activeSeats.length) {
    errors.push({ code: 'NO_WORKERS', message: '至少需要安排 1 个工作席模型。' });
  }
  for (const s of activeSeats) {
    if (!s.model) errors.push({ code: 'SEAT_NO_MODEL', seatId: s.id, message: `工作席「${s.label}」未选择模型。` });
    if (!s.duties.length) errors.push({ code: 'SEAT_NO_DUTY', seatId: s.id, message: `工作席「${s.label}」尚未分配职责（设计/施工/审验）。` });
  }

  const groupsMap = new Map();
  for (const s of activeSeats) {
    for (const d of s.duties) {
      if (d.kind === 'leader' || d.kind === 'member') {
        const key = `${d.role}::${d.groupId}`;
        if (!groupsMap.has(key)) {
          groupsMap.set(key, {
            key,
            role: d.role,
            groupId: d.groupId,
            label: d.groupName || `${ROLE_LABELS[d.role]}组`,
            leaders: [],
            members: [],
            participantIds: []
          });
        }
        const g = groupsMap.get(key);
        g.participantIds.push(s.id);
        if (d.kind === 'leader') g.leaders.push(s.id);
        else g.members.push(s.id);
      }
    }
  }

  const groups = [];
  for (const g of groupsMap.values()) {
    if (g.participantIds.length >= 2) {
      if (g.leaders.length === 0) errors.push({ code: 'GROUP_NO_LEADER', groupKey: g.key, message: `「${g.label}」有 ${g.participantIds.length} 位成员，请指定 1 位组长。` });
      if (g.leaders.length > 1) errors.push({ code: 'GROUP_MULTI_LEADER', groupKey: g.key, message: `「${g.label}」只能有 1 位组长。` });
      if (g.members.length === 0) errors.push({ code: 'GROUP_NO_MEMBER', groupKey: g.key, message: `「${g.label}」至少需要 1 位组员。` });
      groups.push({ key: g.key, role: g.role, groupId: g.groupId, label: g.label, leaderId: g.leaders[0], memberIds: g.members, participantIds: g.participantIds });
    }
  }

  return { ok: errors.length === 0, value: normalized, errors, groups };
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
        const duty = seat?.duties.find(d => d.role === g.role && (d.groupId || `${d.role}-group`) === g.groupId);
        return {
          id: pid,
          label: seat?.label || pid,
          role: g.role,
          kind: duty?.kind || 'member',
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
        if (duty.kind === 'independent' || !groupedSeatRoles.has(`${seat.id}::${duty.role}`)) {
          independents.push({
            key: `ind::${seat.id}::${duty.role}`,
            id: seat.id,
            label: `${ROLE_LABELS[duty.role]} · ${seat.label}`,
            seatLabel: seat.label,
            role: duty.role,
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
      originalUserMessage: null,
      taskGoalText: normalized.goal,
      stage: 'idle',
      stageLabel: '待命 · 输入任务后自动推进',
      round: 1,
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
      designArtifact: normalized.existingDesign?.text ? { version: 'v1', text: normalized.existingDesign.text, approved: true } : null,
      constructionArtifact: null,
      deliverables: [],
      boardTaskIds: {},
      queue: [],
      error: null
    };
    this.runs.set(sessionId, run);
    return run;
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
    for (const g of run.groups) {
      g.stopped = false;
      if (g.statusText === '已停止' || g.statusText === '本组已停止') {
        g.color = 'neutral';
        g.statusText = '准备继续';
      }
    }
    for (const ind of run.independents) {
      if (ind.statusText === '已停止') {
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

  async runSecretaryReport(run, parentAgent, { kind = 'stage', stageSummary = '', details = '', signal }) {
    const secModel = run.secretary?.model;
    if (!secModel || run.stoppedAll) return;
    run.secretary.color = 'yellow';
    run.secretary.status = 'running';
    run.secretary.error = null;
    this.emit(run.sessionId);

    try {
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
        prompt: `【汇报类型】${kind === 'final' ? '全部工作结束后的最终简短总结' : '阶段进度汇报'}\n【当前进展】${stageSummary}\n【成果摘要】\n${String(details).slice(0, 4000)}\n\n请只做简明中文汇报，完整保留各工作组成果与审验结论，不添加免责声明。`,
        signal
      });
      run.secretary.nativeSessionId = res.childId;
      const brief = res.text || stageSummary;
      run.secretary.latestBrief = brief.split(/\r?\n/)[0].slice(0, 120) || stageSummary;
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
      if (kind === 'final') throw err;
    }
    this.emit(run.sessionId);
  }

  async executeGroupStage(run, parentAgent, group, { stageTitle, promptContext, allowWrite = false, isReview = false, taskSignal, attempt = 1, boardTaskId = null }) {
    if (group.stopped || run.stoppedAll) return { stopped: true };
    const rounds = resolveDiscussionRounds({ discussionRounds: run.config.discussionRounds });
    const leaderSeat = run.config.seats.find(s => s.id === group.leaderId);
    const memberSeats = group.memberIds.map(id => run.config.seats.find(s => s.id === id)).filter(Boolean);
    const taskGoalLine = run.taskGoalText ? `\n【任务栏目标】\n${run.taskGoalText}` : '';
    const baseInput = `【用户需求】\n${run.originalUserMessage || '按任务要求执行'}${taskGoalLine}\n\n${promptContext}`;

    const activeBoardTaskId = boardTaskId || group.boardTaskId;
    if (activeBoardTaskId) {
      await this.runtime.updateBoardTask(parentAgent, activeBoardTaskId, 'claim');
    }

    const callMember = async (seat, roleBadge, prompt, outputSchema = undefined) => {
      taskSignal?.throwIfAborted?.();
      if (group.stopped || run.stoppedAll) throw new Error('TASK_STOPPED');
      const mInfo = group.members.find(m => m.id === seat.id);
      const existingChildId = group.childIds?.[seat.id] ?? null;
      const extraGuidance = this.consumeQueuedInstructions(run, { groupKey: group.key, participantId: seat.id });
      const res = await this.runtime.runSeatTurn({
        rootAgent: parentAgent,
        existingChildId,
        name: safeAgentSlug(`${group.role}-${seat.label}-${seat.id.slice(-4)}`),
        label: `${group.label} · ${seat.label}`,
        role: group.role,
        roleBadge,
        seatLabel: seat.label,
        taskId: run.taskId,
        model: seat.model,
        prompt: `${prompt}${extraGuidance}`,
        allowWrite,
        outputSchema,
        signal: taskSignal
      });
      if (!existingChildId || outputSchema === undefined) {
        group.childIds[seat.id] = res.childId;
        if (mInfo) mInfo.nativeSessionId = res.childId;
      }
      return res;
    };

    try {
      group.color = 'yellow';
      group.statusText = '组长开场中';
      this.emit(run.sessionId);

      const openingRes = await callMember(
        leaderSeat,
        `${ROLE_LABELS[group.role]}组长`,
        `【当前阶段：${stageTitle}（第 ${attempt} 轮次）】\n${baseInput}\n\n请作为「${group.label}」组长开场，忠实带入用户需求与约束，向组员（${memberSeats.map(m => m.label).join('、')}）拆分本阶段任务。\n【本组发言节奏】组长开场 -> 各组员依次进行共 ${rounds} 轮发言 -> 组长最终汇总定稿（中间 ${rounds} 轮仅由组员轮流发言，组长不插话）。`
      );

      let transcript = [`【组长 ${leaderSeat.label} · 开场】\n${openingRes.text}`];
      for (let r = 1; r <= rounds; r++) {
        group.round = r;
        for (const mSeat of memberSeats) {
          if (group.stopped || run.stoppedAll) return { stopped: true };
          const mInfo = group.members.find(m => m.id === mSeat.id);
          if (mInfo) { mInfo.color = 'yellow'; mInfo.statusText = `第 ${r}/${rounds} 轮执行中`; }
          group.statusText = `第 ${r}/${rounds} 轮 · ${mSeat.label}`;
          this.emit(run.sessionId);

          const mPrompt = r === 1
            ? `【当前阶段：${stageTitle}】\n${baseInput}\n\n${transcript.join('\n\n')}\n\n现在轮到你进行第 1/${rounds} 轮发言（中间 ${rounds} 轮仅由组员轮流发言，最后由组长统一汇总定稿），请结合以上组长开场和前席内容完成你的部分。`
            : `【最新本组讨论进展（第 ${r}/${rounds} 轮）】\n${transcript.slice(-memberSeats.length).join('\n\n')}\n\n现在轮到你进行第 ${r}/${rounds} 轮发言，请回应前席并深化或修正你的工作成果。`;
          const mRes = await callMember(mSeat, `${ROLE_LABELS[group.role]}组员`, mPrompt);
          transcript.push(`【${mSeat.label} · 第 ${r} 轮】\n${mRes.text}`);
          if (mInfo) { mInfo.color = 'green'; mInfo.statusText = '已提交本轮成果'; }
        }
      }

      group.statusText = '组长定稿中';
      this.emit(run.sessionId);
      const fullTranscript = transcript.map(item => item.length > 2400 ? `${item.slice(0, 2400)}\n…（已按上限略去过长尾部）` : item).join('\n\n');
      const formalPrompt = isReview
        ? `【当前阶段：${stageTitle} · 组长最终裁决（第 ${attempt} 轮次）】\n${baseInput}\n\n【本组全轮完整讨论记录（共 ${rounds} 轮）】\n${fullTranscript}\n\n指定的 ${rounds} 轮讨论已结束。请仅依据以上【用户需求】【待审内容】与【本组全轮完整讨论记录】，通过结构化输出返回最终审验结论（pass 或 changes）与具体意见。若核心任务目标已达成、没有实质阻断缺陷，应判 pass 放行，切勿翻找无关历史文件或因形式化细枝末节无限打回。`
        : `指定的 ${rounds} 轮讨论已结束。以下是本组从开场到第 ${rounds} 轮的完整讨论记录：\n\n${fullTranscript}\n\n请基于以上全部讨论内容，汇总形成本组最终正式成果。`;
      const formalRes = await callMember(
        leaderSeat,
        `${ROLE_LABELS[group.role]}组长`,
        formalPrompt,
        isReview ? REVIEW_OUTPUT_SCHEMA : undefined
      );

      const finalText = isReview && formalRes.structured
        ? `[${formalRes.structured.conclusion === 'pass' ? '明确通过' : '退回修改'}]\n${formalRes.structured.summary}`
        : formalRes.text;

      group.formalText = finalText;
      group.formalVersion = `${group.role}-v${attempt}`;
      group.color = 'green';
      group.statusText = '正式成果已转交';
      for (const m of group.members) { m.color = 'green'; m.statusText = '已完成交接'; }

      // 中间阶段成果保留在各自子会话与右侧内阁面板，不往主对话刷屏
      if (activeBoardTaskId) {
        await this.runtime.updateBoardTask(parentAgent, activeBoardTaskId, 'complete');
      }
      this.emit(run.sessionId);
      return { stopped: false, text: finalText, review: formalRes.structured ?? null };
    } catch (err) {
      if (err.message === 'TASK_STOPPED' || taskSignal?.aborted || group.stopped || run.stoppedAll) {
        group.color = 'neutral';
        group.statusText = '已停止';
        this.emit(run.sessionId);
        return { stopped: true };
      }
      group.color = 'red';
      group.statusText = `执行出错：${err.message}`;
      this.emit(run.sessionId);
      throw err;
    }
  }

  async executeIndependentStage(run, parentAgent, ind, { stageTitle, promptContext, allowWrite = false, isReview = false, taskSignal, attempt = 1, boardTaskId = null }) {
    if (run.stoppedAll) return { stopped: true };
    const seat = run.config.seats.find(s => s.id === ind.id);
    if (!seat) return { stopped: false, text: '' };
    const taskGoalLine = run.taskGoalText ? `\n【任务栏目标】\n${run.taskGoalText}` : '';
    const baseInput = `【用户需求】\n${run.originalUserMessage || '按任务要求执行'}${taskGoalLine}\n\n${promptContext}`;

    const activeBoardTaskId = boardTaskId || ind.boardTaskId;
    if (activeBoardTaskId) {
      await this.runtime.updateBoardTask(parentAgent, activeBoardTaskId, 'claim');
    }

    try {
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
        allowWrite,
        outputSchema: isReview ? REVIEW_OUTPUT_SCHEMA : undefined,
        prompt: (isReview
          ? `${baseInput}\n\n请完成${stageTitle}，并通过结构化输出返回审验结论（pass 或 changes）与具体意见。`
          : `${baseInput}\n\n请完成${stageTitle}并输出完整成果。`) + extraGuidance,
        signal: taskSignal
      });
      if (!ind.nativeSessionId || !isReview) ind.nativeSessionId = res.childId;
      const finalText = isReview && res.structured
        ? `[${res.structured.conclusion === 'pass' ? '明确通过' : '退回修改'}]\n${res.structured.summary}`
        : res.text;
      ind.outputText = finalText;
      ind.color = 'green';
      ind.statusText = '成果已成功转交';

      // 中间独立席成果保留在独立子会话与右侧内阁面板，不往主对话刷屏
      if (activeBoardTaskId) {
        await this.runtime.updateBoardTask(parentAgent, activeBoardTaskId, 'complete');
      }
      this.emit(run.sessionId);
      return { stopped: false, text: finalText, review: res.structured ?? null };
    } catch (err) {
      if (err.message === 'TASK_STOPPED' || taskSignal?.aborted || run.stoppedAll) {
        ind.color = 'neutral';
        ind.statusText = '已停止';
        this.emit(run.sessionId);
        return { stopped: true };
      }
      ind.color = 'red';
      ind.statusText = `执行出错：${err.message}`;
      this.emit(run.sessionId);
      throw err;
    }
  }

  async initBoardTasks(run, parentAgent) {
    if (!parentAgent) return;
    await this.runtime.ensureTeamEnabled(parentAgent);
    if (!run.boardTaskIds) run.boardTaskIds = {};
    const findUnits = (role, target = null) => ({
      groups: run.groups.filter(g => g.role === role),
      inds: run.independents.filter(i => i.role === role && (!target || (i.reviewTargets ?? ['design', 'construction']).includes(target)))
    });
    const dU = findUnits('design'), drU = findUnits('review', 'design');
    const cU = findUnits('construction'), crU = findUnits('review', 'construction');

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

    await addLayer('design', '', [...dU.groups, ...dU.inds], '设计阶段：制定方案与接口契约');
    await addLayer('design-review', '设计审验', [...drU.groups, ...drU.inds], '设计审验：核查设计方案完整性与可行性');
    await addLayer('construction', '', [...cU.groups, ...cU.inds], '施工阶段：按已认可设计实施并验证产物');
    await addLayer('construction-review', '施工审验', [...crU.groups, ...crU.inds], '施工审验：核查施工结果与测试证据');
  }

  boardTaskIdFor(run, phaseKey, unit) {
    return run.boardTaskIds?.[`${phaseKey}::${unit.key}`] ?? unit.boardTaskId ?? null;
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
    if (run.stoppedAll) return run;

    const taskCtrl = new AbortController();
    this.taskControllers.set(sessionId, taskCtrl);
    const taskSignal = taskCtrl.signal;

    try {
      await this.initBoardTasks(run, parentAgent);
      const findUnits = (role, target = null) => ({
        groups: run.groups.filter(g => g.role === role),
        inds: run.independents.filter(i => i.role === role && (!target || (i.reviewTargets ?? ['design', 'construction']).includes(target)))
      });
      const dU = findUnits('design'), drU = findUnits('review', 'design');
      const cU = findUnits('construction'), crU = findUnits('review', 'construction');

      if ((dU.groups.length || dU.inds.length) && !run.designArtifact?.approved) {
        let feedback = '';
        for (let attempt = 1; attempt <= 2; attempt++) {
          run.stage = 'design';
          run.stageLabel = attempt > 1 ? `设计修改（第 ${attempt} 轮）` : '设计方案制定中';
          this.emit(sessionId);
          const dOut = [];
          const ctxText = `【任务要求】\n${taskPrompt}${feedback ? `\n\n【审验退回意见】\n${feedback}` : ''}`;
          for (const g of dU.groups) {
            const r = await this.executeGroupStage(run, parentAgent, g, { stageTitle: '设计方案', promptContext: ctxText, allowWrite: false, taskSignal, attempt, boardTaskId: this.boardTaskIdFor(run, 'design', g) });
            if (r.stopped) return run;
            if (r.text) dOut.push(r.text);
          }
          for (const ind of dU.inds) {
            const r = await this.executeIndependentStage(run, parentAgent, ind, { stageTitle: '设计方案', promptContext: ctxText, allowWrite: false, taskSignal, attempt, boardTaskId: this.boardTaskIdFor(run, 'design', ind) });
            if (r.stopped) return run;
            if (r.text) dOut.push(r.text);
          }
          const combined = dOut.join('\n\n');
          run.designArtifact = { version: `design-v${attempt}`, text: combined, approved: false };
          await this.runSecretaryReport(run, parentAgent, { kind: 'stage', stageSummary: `已完成设计稿（${run.designArtifact.version}），进入设计审验。`, details: combined, signal: taskSignal });

          if (drU.groups.length || drU.inds.length) {
            run.stage = 'design-review';
            run.stageLabel = '设计审验中';
            this.emit(sessionId);
            const revs = [];
            const rCtx = `【任务要求】\n${taskPrompt}\n\n【待审设计方案】\n${combined}`;
            for (const g of drU.groups) {
              const r = await this.executeGroupStage(run, parentAgent, g, { stageTitle: '设计审验', promptContext: rCtx, allowWrite: false, isReview: true, taskSignal, attempt, boardTaskId: this.boardTaskIdFor(run, 'design-review', g) });
              if (r.stopped) return run;
              const conclusion = r.review?.conclusion || 'pass';
              g.reviewConclusion = conclusion;
              revs.push({ conclusion, summary: r.review?.summary || r.text });
            }
            for (const ind of drU.inds) {
              const r = await this.executeIndependentStage(run, parentAgent, ind, { stageTitle: '设计审验', promptContext: rCtx, allowWrite: false, isReview: true, taskSignal, attempt, boardTaskId: this.boardTaskIdFor(run, 'design-review', ind) });
              if (r.stopped) return run;
              const conclusion = r.review?.conclusion || 'pass';
              ind.reviewConclusion = conclusion;
              revs.push({ conclusion, summary: r.review?.summary || r.text });
            }
            const rejected = revs.find(d => d.conclusion === 'changes');
            if (rejected && attempt === 2) {
              run.stage = 'design-blocked';
              run.stageLabel = '设计审验未通过';
              run.error = rejected.summary;
              if (parentAgent) {
                await this.runtime.appendMainAssistantMessage(parentAgent, {
                  taskId: run.taskId,
                  actorLabel: '内阁编排',
                  groupLabel: '设计审验未通过',
                  title: '设计审验未通过 · 流程暂停',
                  role: 'review',
                  phase: 'cabinet-blocked',
                  text: `设计方案经两轮审验仍未通过，尚未进入施工阶段。核心意见：\n\n${rejected.summary}\n\n可在右侧「内阁」面板打开设计组或审验组讨论查看完整过程。`
                });
              }
              this.emit(sessionId);
              return run;
            }
            if (rejected) {
              feedback = rejected.summary;
              for (const u of [...dU.groups, ...dU.inds]) {
                const tid = this.boardTaskIdFor(run, 'design', u);
                if (tid) await this.runtime.updateBoardTask(parentAgent, tid, 'reopen');
              }
              for (const u of [...drU.groups, ...drU.inds]) {
                const tid = this.boardTaskIdFor(run, 'design-review', u);
                if (tid) await this.runtime.updateBoardTask(parentAgent, tid, 'reopen');
              }
              await this.runSecretaryReport(run, parentAgent, { kind: 'stage', stageSummary: '设计审验提出修改意见，返回设计席修订。', details: feedback, signal: taskSignal });
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
      return await this._finishConstructionAndDelivery(run, parentAgent, { cU, crU, taskSignal });
    } catch (err) {
      if (!taskSignal.aborted && err.message !== 'TASK_STOPPED') {
        run.error = err.message;
        run.stageLabel = `执行受阻：${err.message}`;
        this.emit(sessionId);
      }
      return run;
    } finally {
      if (this.taskControllers.get(sessionId) === taskCtrl) this.taskControllers.delete(sessionId);
    }
  }

  async _finishConstructionAndDelivery(run, parentAgent, { cU, crU, taskSignal }) {
    const sessionId = run.sessionId;
    if (cU.groups.length || cU.inds.length) {
      const designText = run.designArtifact?.text || '按任务要求直接实施';
      let feedback = '';
      for (let attempt = 1; attempt <= 2; attempt++) {
        run.stage = 'construction';
        run.stageLabel = attempt > 1 ? `施工返工（第 ${attempt} 轮）` : '按认可设计施工中';
        this.emit(sessionId);
        const bOut = [];
        const cCtx = `【已认可设计】\n${designText}${feedback ? `\n\n【审验退回修改要求】\n${feedback}` : ''}`;
        for (const g of cU.groups) {
          const r = await this.executeGroupStage(run, parentAgent, g, { stageTitle: '工程施工', promptContext: cCtx, allowWrite: true, taskSignal, attempt, boardTaskId: this.boardTaskIdFor(run, 'construction', g) });
          if (r.stopped) return run;
          if (r.text) bOut.push(r.text);
        }
        for (const ind of cU.inds) {
          const r = await this.executeIndependentStage(run, parentAgent, ind, { stageTitle: '工程施工', promptContext: cCtx, allowWrite: true, taskSignal, attempt, boardTaskId: this.boardTaskIdFor(run, 'construction', ind) });
          if (r.stopped) return run;
          if (r.text) bOut.push(r.text);
        }
        const combinedBuild = bOut.join('\n\n');
        run.constructionArtifact = { version: `build-v${attempt}`, text: combinedBuild };

        if (crU.groups.length || crU.inds.length) {
          run.stage = 'construction-review';
          run.stageLabel = '施工审验中';
          this.emit(sessionId);
          const bRevs = [];
          const crCtx = `【已认可设计】\n${designText}\n\n【施工成果】\n${combinedBuild}`;
          for (const g of crU.groups) {
            const r = await this.executeGroupStage(run, parentAgent, g, { stageTitle: '施工审验', promptContext: crCtx, allowWrite: false, isReview: true, taskSignal, attempt, boardTaskId: this.boardTaskIdFor(run, 'construction-review', g) });
            if (r.stopped) return run;
            const conclusion = r.review?.conclusion || 'pass';
            g.reviewConclusion = conclusion;
            bRevs.push({ conclusion, summary: r.review?.summary || r.text });
          }
          for (const ind of crU.inds) {
            const r = await this.executeIndependentStage(run, parentAgent, ind, { stageTitle: '施工审验', promptContext: crCtx, allowWrite: false, isReview: true, taskSignal, attempt, boardTaskId: this.boardTaskIdFor(run, 'construction-review', ind) });
            if (r.stopped) return run;
            const conclusion = r.review?.conclusion || 'pass';
            ind.reviewConclusion = conclusion;
            bRevs.push({ conclusion, summary: r.review?.summary || r.text });
          }
          const rejected = bRevs.find(d => d.conclusion === 'changes');
          if (rejected && attempt === 2) {
            run.stage = 'construction-blocked';
            run.stageLabel = '施工审验未通过';
            run.error = rejected.summary;
            if (parentAgent) {
              await this.runtime.appendMainAssistantMessage(parentAgent, {
                taskId: run.taskId,
                actorLabel: '内阁编排',
                groupLabel: '施工审验未通过',
                title: '施工审验未通过 · 流程暂停',
                role: 'review',
                phase: 'cabinet-blocked',
                text: `施工成果经两轮审验仍未通过。核心意见：\n\n${rejected.summary}\n\n可在右侧「内阁」面板打开施工组或审验组讨论查看完整过程。`
              });
            }
            this.emit(sessionId);
            return run;
          }
          if (rejected) {
            feedback = rejected.summary;
            for (const u of [...cU.groups, ...cU.inds]) {
              const tid = this.boardTaskIdFor(run, 'construction', u);
              if (tid) await this.runtime.updateBoardTask(parentAgent, tid, 'reopen');
            }
            for (const u of [...crU.groups, ...crU.inds]) {
              const tid = this.boardTaskIdFor(run, 'construction-review', u);
              if (tid) await this.runtime.updateBoardTask(parentAgent, tid, 'reopen');
            }
            await this.runSecretaryReport(run, parentAgent, { kind: 'stage', stageSummary: '施工审验发现问题，退回施工席返工。', details: feedback, signal: taskSignal });
            continue;
          }
        }
        break;
      }
    }

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

    const combinedFinalText = [finalDeliverable.designText, finalDeliverable.constructionText].filter(Boolean).join('\n\n');
    if (run.secretary?.model) {
      await this.runSecretaryReport(run, parentAgent, {
        kind: 'final',
        stageSummary: '本轮全部工作组与独立席已完成交付，现呈交完整成果并等待你验收。',
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
    run.stageLabel = '已交付主对话 · 已自动退回单模型';
    run.userAcceptanceStatus = 'awaiting-user';
    this.emit(sessionId);
    try { await this.onCompleted?.(sessionId); } catch {}
    return run;
  }
}
