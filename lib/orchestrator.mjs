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
  }

  getRun(sessionId) { return this.runs.get(sessionId) ?? null; }

  emit(sessionId) {
    const run = this.runs.get(sessionId);
    if (run && typeof this.onStateChange === 'function') { try { this.onStateChange(sessionId, run); } catch {} }
  }

  ensureRun(sessionId, config, workspaceRoot) {
    const validated = validateCabinetConfig(config, 'task');
    const normalized = validated.value;
    let run = this.runs.get(sessionId);
    const groupMap = new Map((run?.groups ?? []).map(g => [g.key, g]));

    const groups = validated.groups.map(g => {
      const prev = groupMap.get(g.key);
      return {
        ...g,
        round: prev?.round ?? 1,
        color: prev?.color ?? 'neutral',
        statusText: prev?.statusText ?? '等待前序阶段',
        stopped: prev?.stopped ?? false,
        canResume: prev?.canResume ?? false,
        reviewConclusion: prev?.reviewConclusion ?? null,
        formalText: prev?.formalText ?? null,
        formalVersion: prev?.formalVersion ?? null,
        handoffReceived: prev?.handoffReceived ?? false,
        materials: prev?.materials ?? [],
        files: prev?.files ?? [],
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
          independents.push({
            key: `ind::${seat.id}::${duty.role}`, id: seat.id, label: `${ROLE_LABELS[duty.role]} · ${seat.label}`,
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
      workspaceRoot: workspaceRoot || run?.workspaceRoot || process.cwd(),
      stage: run?.stage ?? 'idle', stageLabel: run?.stageLabel ?? '待命 · 输入任务后自动推进',
      round: run?.round ?? 1, stoppedAll: run?.stoppedAll ?? false,
      awaitingHumanApproval: run?.awaitingHumanApproval ?? false, userAcceptanceStatus: run?.userAcceptanceStatus ?? 'pending',
      groups, independents, subteams: run?.subteams ?? [],
      secretary: normalized.secretary.model ? {
        model: normalized.secretary.model,
        label: `秘书 · ${normalized.secretary.model.shortLabel}`,
        color: run?.secretary?.color ?? 'neutral',
        latestBrief: run?.secretary?.latestBrief ?? '待任务启动后汇报进度。',
        reports: run?.secretary?.reports ?? []
      } : null,
      designArtifact: run?.designArtifact ?? (normalized.existingDesign?.text ? { version: normalized.existingDesign.version || 'v1', text: normalized.existingDesign.text, approved: !!normalized.existingDesign.approved } : null),
      constructionArtifact: run?.constructionArtifact ?? null,
      deliverables: run?.deliverables ?? [], originals: run?.originals ?? [],
      queue: run?.queue ?? [], activeActor: run?.activeActor ?? null, error: null
    };
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
    this.groupControllers.delete(ctrlKey);
    group.stopped = true;
    group.canResume = true;
    group.color = 'neutral';
    group.statusText = '本组已停止';
    for (const m of group.members) {
      if (m.color === 'yellow') { m.color = 'neutral'; m.statusText = '已停止'; }
    }
    this.emit(sessionId);
    return run;
  }

  async resumeGroup(sessionId, groupKey, parentAgent = null) {
    const run = this.runs.get(sessionId);
    if (!run || run.stoppedAll) return run;
    const group = run.groups.find(g => g.key === groupKey || g.groupId === groupKey);
    if (!group) return run;
    group.stopped = false;
    group.canResume = false;
    group.statusText = '准备继续本组工作';
    this.emit(sessionId);
    if (run.lastTaskPrompt) {
      void this.runTask(sessionId, parentAgent, run.lastTaskPrompt, { resumeOnlyGroupKey: group.key });
    }
    return run;
  }

  stopAll(sessionId) {
    const run = this.runs.get(sessionId);
    if (!run) return null;
    this.taskControllers.get(sessionId)?.abort(new Error('TASK_STOPPED'));
    this.taskControllers.delete(sessionId);
    for (const [k, ctrl] of this.groupControllers.entries()) {
      if (k.startsWith(`${sessionId}::`)) {
        ctrl.abort(new Error('TASK_STOPPED'));
        this.groupControllers.delete(k);
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
    }
    for (const ind of run.independents) {
      if (ind.color === 'yellow') { ind.color = 'neutral'; ind.statusText = '已停止'; }
    }
    this.emit(sessionId);
    return run;
  }

  async resumeAll(sessionId, parentAgent = null) {
    const run = this.runs.get(sessionId);
    if (!run) return null;
    run.stoppedAll = false;
    for (const g of run.groups) {
      g.stopped = false;
      g.canResume = false;
    }
    run.stageLabel = '已恢复工作流';
    this.emit(sessionId);
    if (run.lastTaskPrompt && run.stage !== 'completed') {
      void this.runTask(sessionId, parentAgent, run.lastTaskPrompt, { isResume: true });
    }
    return run;
  }

  enqueueInstruction(sessionId, { groupKey = null, selector = 'current', participantId = null, text = '' }) {
    const run = this.runs.get(sessionId);
    if (!run || !String(text || '').trim()) throw new Error('请输入补充指令内容');
    let targetSeat = null;
    if (participantId) {
      targetSeat = run.config.seats.find(s => s.id === participantId && s.inSeat);
    } else if (selector === 'current' && run.activeActor) {
      targetSeat = run.config.seats.find(s => s.id === run.activeActor.id && s.inSeat);
    }
    if (!targetSeat && groupKey) {
      const g = run.groups.find(item => item.key === groupKey);
      const leaderId = g?.leaderId ?? g?.participantIds?.[0];
      targetSeat = run.config.seats.find(s => s.id === leaderId);
    }
    if (!targetSeat) {
      targetSeat = run.config.seats.find(s => s.inSeat) ?? run.config.seats[0];
    }
    const item = {
      id: `inst-${crypto.randomUUID().slice(0, 8)}`,
      at: new Date().toISOString(),
      groupKey: groupKey || null,
      selector,
      targetId: targetSeat?.id ?? 'next',
      targetLabel: targetSeat ? `${targetSeat.label}` : '下一位发言参与者',
      configVersion: run.configVersion,
      status: 'queued',
      text: String(text).trim()
    };
    run.queue.push(item);
    this.emit(sessionId);
    return item;
  }

  consumeQueuedGuidance(run, actorId, groupKey = null) {
    const matched = run.queue.filter(q => q.status === 'queued' && (q.targetId === actorId || q.targetId === 'next' || (groupKey && q.groupKey === groupKey)));
    for (const q of matched) {
      q.status = 'delivered';
      q.deliveredAt = new Date().toISOString();
    }
    return matched.map(q => q.text).join('\n');
  }

  async invokeActorWithTools({ run, seat, role, roleBadge, groupKey = null, groupLabel = null, stageTitle = '', userPrompt, allowWrite = false, signal }) {
    const memCtx = this.memory.formatPromptContext({
      role,
      providerId: seat.model.providerId,
      modelId: seat.model.modelId,
      projectId: run.taskId
    });
    const guidance = this.consumeQueuedGuidance(run, seat.id, groupKey);
    const systemPrompt = [
      `你是内阁中的「${seat.label}」，当前担任职责：${roleBadge}。`,
      memCtx.promptBlock
    ].filter(Boolean).join('\n\n');

    const fullUserPrompt = [userPrompt, guidance ? `【用户补充指令】\n${guidance}` : ''].filter(Boolean).join('\n\n');
    const tools = this.sessions.toolsForRole(role, { allowWrite });
    const toolRecords = [];
    let currentPrompt = fullUserPrompt;
    let finalText = '';

    run.activeActor = { id: seat.id, label: seat.label, role, groupKey };
    this.emit(run.sessionId);

    for (let step = 0; step < 3; step++) {
      signal?.throwIfAborted?.();
      const resp = await this.llm.invokeModel({
        modelRef: seat.model,
        systemPrompt,
        userPrompt: currentPrompt,
        tools,
        sessionId: run.sessionId,
        signal
      });
      if (resp.text) finalText = resp.text;
      if (!resp.toolCalls || resp.toolCalls.length === 0) break;

      const stepOutputs = [];
      for (const tc of resp.toolCalls) {
        signal?.throwIfAborted?.();
        try {
          const out = await this.sessions.executeToolCall(tc, {
            workspaceRoot: run.workspaceRoot,
            role,
            allowWrite,
            signal
          });
          toolRecords.push({ id: tc.id, name: tc.name, path: out.path, status: '已完成', output: out.output });
          stepOutputs.push(`工具 ${tc.name}(${out.path}) 执行结果：\n${out.output}`);
        } catch (err) {
          toolRecords.push({ id: tc.id, name: tc.name, path: tc.arguments?.path || '.', status: '失败', output: err.message });
          stepOutputs.push(`工具 ${tc.name} 报错：${err.message}`);
        }
      }
      currentPrompt = `${fullUserPrompt}\n\n【工具执行反馈】\n${stepOutputs.join('\n\n')}\n\n请基于以上工具结果给出完整结论。`;
    }

    run.activeActor = null;
    const orig = this.sessions.saveOriginal(run.sessionId, {
      kind: groupKey ? 'group-turn' : 'independent-turn',
      groupKey,
      actorId: seat.id,
      actorLabel: seat.label,
      role,
      roleBadge,
      providerId: seat.model.providerId,
      modelId: seat.model.modelId,
      text: finalText,
      toolRecords
    });
    run.originals.push(orig);

    if (groupKey) {
      this.sessions.appendGroupMessage(run.sessionId, groupKey, groupLabel, run.round, {
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
    }
    this.emit(run.sessionId);
    return { text: finalText, toolRecords, sourceId: orig.sourceId };
  }

  async runSecretaryReport(run, parentAgent, { kind = 'stage', stageSummary = '', details = '' }) {
    const secModel = run.config.secretary?.model;
    if (!secModel || !run.secretary) return;
    const memCtx = this.memory.formatPromptContext({
      role: 'secretary',
      providerId: secModel.providerId,
      modelId: secModel.modelId,
      projectId: run.taskId
    });
    run.secretary.color = 'yellow';
    this.emit(run.sessionId);

    try {
      const resp = await this.llm.invokeModel({
        modelRef: secModel,
        systemPrompt: `你是内阁秘书（${secModel.shortLabel}）。只做简明中文阶段汇报或最终总结，不改写或截断原成果。\n${memCtx.promptBlock}`,
        userPrompt: `【汇报类型】${kind === 'final' ? '全部工作结束后的最终简短总结' : '阶段进度汇报'}\n【当前进展】${stageSummary}\n【成果摘要】\n${details.slice(0, 4000)}`,
        tools: [],
        sessionId: run.sessionId
      });
      const brief = resp.text || stageSummary;
      const orig = this.sessions.saveOriginal(run.sessionId, {
        kind: kind === 'final' ? 'secretary-final' : 'secretary-stage',
        actorId: 'secretary',
        actorLabel: run.secretary.label,
        role: 'secretary',
        providerId: secModel.providerId,
        modelId: secModel.modelId,
        text: brief
      });
      run.originals.push(orig);
      run.secretary.latestBrief = brief.split(/\r?\n/)[0].slice(0, 120) || stageSummary;
      run.secretary.color = 'green';
      run.secretary.reports.push({
        id: orig.sourceId,
        kind,
        at: new Date().toISOString(),
        text: brief,
        sourceId: orig.sourceId
      });
      if (kind === 'final' && parentAgent) {
        this.sessions.appendMainAssistantMessage(parentAgent, {
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
    } catch {
      run.secretary.latestBrief = stageSummary;
      run.secretary.color = 'neutral';
    }
    this.emit(run.sessionId);
  }

  async executeGroupStage(run, parentAgent, group, { stageTitle, promptContext, allowWrite = false, isReview = false, taskSignal }) {
    if (group.stopped || run.stoppedAll) return { stopped: true };
    const ctrlKey = `${run.sessionId}::${group.key}`;
    const groupCtrl = new AbortController();
    const onTaskAbort = () => groupCtrl.abort(new Error('TASK_STOPPED'));
    taskSignal?.addEventListener('abort', onTaskAbort, { once: true });
    this.groupControllers.set(ctrlKey, groupCtrl);

    const leaderSeat = run.config.seats.find(s => s.id === group.leaderId);
    const memberSeats = group.memberIds.map(id => run.config.seats.find(s => s.id === id)).filter(Boolean);

    try {
      group.color = 'yellow';
      group.statusText = `${stageTitle} · 组长分派中`;
      this.emit(run.sessionId);

      const allocRes = await this.invokeActorWithTools({
        run, seat: leaderSeat, role: group.role, roleBadge: `${ROLE_LABELS[group.role]}组长`,
        groupKey: group.key, groupLabel: group.label, stageTitle,
        userPrompt: `【当前阶段：${stageTitle}】\n${promptContext}\n\n请作为${group.label}组长，明确本组各成员（${memberSeats.map(m => m.label).join('、')}）的分工重点与你自己承担的部分。`,
        allowWrite: false, signal: groupCtrl.signal
      });

      const contributions = [];
      for (const mSeat of memberSeats) {
        if (group.stopped || run.stoppedAll) return { stopped: true };
        const mInfo = group.members.find(m => m.id === mSeat.id);
        if (mInfo) { mInfo.color = 'yellow'; mInfo.statusText = '执行实务中'; }
        group.statusText = `${stageTitle} · ${mSeat.label} 实作中`;
        this.emit(run.sessionId);

        const contribRes = await this.invokeActorWithTools({
          run, seat: mSeat, role: group.role, roleBadge: `${ROLE_LABELS[group.role]}组员`,
          groupKey: group.key, groupLabel: group.label, stageTitle,
          userPrompt: `【当前阶段：${stageTitle}】\n${promptContext}\n\n【组长分派方案】\n${allocRes.text}\n\n请完成你负责的${ROLE_LABELS[group.role]}实务并给出具体成果。`,
          allowWrite, signal: groupCtrl.signal
        });
        contributions.push({ seat: mSeat, text: contribRes.text, toolRecords: contribRes.toolRecords });
        if (mInfo) { mInfo.color = 'green'; mInfo.statusText = '已提交本轮成果'; }
      }

      group.statusText = `${stageTitle} · 组长汇总定稿中`;
      this.emit(run.sessionId);

      const contribBlock = contributions.map(c => `【成员 ${c.seat.label} 成果】\n${c.text}`).join('\n\n');
      const formalPrompt = isReview
        ? `【当前阶段：${stageTitle}】\n${promptContext}\n\n${contribBlock}\n\n请作为审验组长汇总本组审验结论。第一行请写明 [明确通过] 或 [退回修改]，若退回请逐条列出需修改的具体问题。`
        : `【当前阶段：${stageTitle}】\n${promptContext}\n\n${contribBlock}\n\n请作为${group.label}组长审阅并整合全组成员成果，输出本组完整正式成果。`;

      const formalRes = await this.invokeActorWithTools({
        run, seat: leaderSeat, role: group.role, roleBadge: `${ROLE_LABELS[group.role]}组长`,
        groupKey: group.key, groupLabel: group.label, stageTitle,
        userPrompt: formalPrompt, allowWrite, signal: groupCtrl.signal
      });

      const version = `${group.role}-v${run.round}`;
      group.formalVersion = version;
      group.formalText = formalRes.text;
      group.handoffReceived = true;
      group.color = 'green';
      group.statusText = '正式成果已转交';
      for (const m of group.members) { m.color = 'green'; m.statusText = '已完成交接'; }

      if (parentAgent) {
        this.sessions.appendMainAssistantMessage(parentAgent, {
          title: `${group.label} · 组长 ${leaderSeat.label}`,
          role: group.role,
          participantId: leaderSeat.id,
          providerId: leaderSeat.model.providerId,
          modelId: leaderSeat.model.modelId,
          phase: isReview ? `${stageTitle}` : group.role,
          groupKey: group.key,
          formalVersion: version,
          text: formalRes.text,
          sourceId: formalRes.sourceId
        });
      }
      this.emit(run.sessionId);
      return { stopped: false, text: formalRes.text, version, sourceId: formalRes.sourceId };
    } catch (err) {
      if (groupCtrl.signal.aborted || err.message === 'GROUP_STOPPED' || err.message === 'TASK_STOPPED') {
        group.color = 'neutral';
        group.statusText = '已停止';
        this.emit(run.sessionId);
        return { stopped: true };
      }
      group.color = 'red';
      group.statusText = `需人工排障：${err.message}`;
      this.emit(run.sessionId);
      throw err;
    } finally {
      taskSignal?.removeEventListener('abort', onTaskAbort);
      this.groupControllers.delete(ctrlKey);
    }
  }

  async executeIndependentStage(run, parentAgent, ind, { stageTitle, promptContext, allowWrite = false, isReview = false, taskSignal }) {
    if (run.stoppedAll) return { stopped: true };
    const seat = run.config.seats.find(s => s.id === ind.id);
    if (!seat) return { stopped: false, text: '' };
    try {
      ind.color = 'yellow';
      ind.statusText = `${stageTitle}进行中`;
      this.emit(run.sessionId);

      const prompt = isReview
        ? `${promptContext}\n\n请完成${stageTitle}。第一行请写明 [明确通过] 或 [退回修改]，若退回请逐条列出需修改的具体问题。`
        : `${promptContext}\n\n请完成${stageTitle}并输出完整成果。`;

      const res = await this.invokeActorWithTools({
        run, seat, role: ind.role, roleBadge: `${ROLE_LABELS[ind.role]} · ${seat.label}`,
        stageTitle, userPrompt: prompt, allowWrite, signal: taskSignal
      });
      ind.outputText = res.text;
      ind.color = 'green';
      ind.statusText = '成果已成功转交';

      if (parentAgent) {
        this.sessions.appendMainAssistantMessage(parentAgent, {
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
      this.emit(run.sessionId);
      return { stopped: false, text: res.text, sourceId: res.sourceId };
    } catch (err) {
      if (taskSignal?.aborted || err.message === 'TASK_STOPPED') {
        ind.color = 'neutral';
        ind.statusText = '已停止';
        this.emit(run.sessionId);
        return { stopped: true };
      }
      ind.color = 'red';
      ind.statusText = `需人工排障：${err.message}`;
      this.emit(run.sessionId);
      throw err;
    }
  }

  async createSubteam(sessionId, { title, leaderId, memberIds, goal }) {
    const run = this.runs.get(sessionId);
    if (!run) throw new Error('任务尚未初始化');
    const poolScope = run.config.policies?.memberPool?.scope || 'group';
    const subKey = `subteam::${Date.now().toString(36)}`;
    const subteam = {
      key: subKey, title: title || '跨组专题小组', poolScope, leaderId,
      memberIds: Array.isArray(memberIds) ? memberIds : [],
      goal: String(goal || ''), status: 'completed', createdAt: new Date().toISOString()
    };
    run.subteams.push(subteam);
    this.sessions.appendGroupMessage(sessionId, subKey, subteam.title, run.round, {
      stageTitle: '临时小组协调', actorId: leaderId, actorLabel: leaderId, roleLabel: '小组负责人',
      text: `已组建临时小组「${subteam.title}」（范围：${poolScope}），完成专项协调并回交原组长。`
    });
    this.emit(sessionId);
    return subteam;
  }

  async runTask(sessionId, parentAgent, userText = '', options = {}) {
    const run = this.runs.get(sessionId);
    if (!run) return null;
    if (userText?.trim()) {
      run.lastTaskPrompt = userText.trim();
      if (!run.config.goal) run.config.goal = userText.trim().slice(0, 120);
    }
    const taskPrompt = run.lastTaskPrompt || run.config.goal || '执行当前内阁任务';

    if (run.awaitingHumanApproval && /认可|同意|通过|继续施工/i.test(userText)) {
      run.awaitingHumanApproval = false;
      if (run.designArtifact) run.designArtifact.approved = true;
    } else if (run.userAcceptanceStatus === 'awaiting-user' && /验收通过|确认验收/i.test(userText)) {
      run.userAcceptanceStatus = 'accepted';
      run.stage = 'accepted';
      run.stageLabel = '用户已确认验收';
      this.emit(sessionId);
      return run;
    }

    run.stoppedAll = false;
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

      if (!options.resumeOnlyGroupKey && (dU.groups.length || dU.inds.length) && !run.designArtifact?.approved) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          run.stage = 'design';
          run.stageLabel = attempt > 1 ? `设计修改（第 ${attempt} 轮）` : '设计方案制定中';
          this.emit(sessionId);
          const dOut = [];
          for (const g of dU.groups) {
            const r = await this.executeGroupStage(run, parentAgent, g, { stageTitle: '设计方案', promptContext: `【任务要求】\n${taskPrompt}`, allowWrite: false, taskSignal });
            if (r.stopped) return run;
            if (r.text) dOut.push(r.text);
          }
          for (const ind of dU.inds) {
            const r = await this.executeIndependentStage(run, parentAgent, ind, { stageTitle: '设计方案', promptContext: `【任务要求】\n${taskPrompt}`, allowWrite: false, taskSignal });
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
              const r = await this.executeGroupStage(run, parentAgent, g, { stageTitle: '设计审验', promptContext: `【任务要求】\n${taskPrompt}\n\n【待审设计方案】\n${combined}`, isReview: true, taskSignal });
              if (r.stopped) return run;
              const dec = extractReviewDecision(r.text);
              g.reviewConclusion = dec.conclusion;
              revs.push(dec);
            }
            for (const ind of drU.inds) {
              const r = await this.executeIndependentStage(run, parentAgent, ind, { stageTitle: '设计审验', promptContext: `【任务要求】\n${taskPrompt}\n\n【待审设计方案】\n${combined}`, isReview: true, taskSignal });
              if (r.stopped) return run;
              const dec = extractReviewDecision(r.text);
              ind.reviewConclusion = dec.conclusion;
              revs.push(dec);
            }
            const rejected = revs.find(d => d.conclusion === 'changes');
            if (rejected && attempt < 2) {
              await this.runSecretaryReport(run, parentAgent, { kind: 'stage', stageSummary: '设计审验提出修改意见，返回设计席修订。', details: rejected.summary });
              continue;
            }
          }
          run.designArtifact.approved = true;
          break;
        }
        if (run.config.policies?.humanApprovalRequired === true) {
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
      this.taskControllers.delete(sessionId);
    }
  }

  async _finishConstructionAndDelivery(run, parentAgent, taskPrompt, { cU, crU, taskSignal, options = {} }) {
    const sessionId = run.sessionId;
    if (cU.groups.length || cU.inds.length) {
      const designText = run.designArtifact?.text || run.config.existingDesign?.text || '按任务要求直接实施';
      for (let attempt = 1; attempt <= 2; attempt++) {
        run.stage = 'construction';
        run.stageLabel = attempt > 1 ? `施工返工（第 ${attempt} 轮）` : '按认可设计施工中';
        this.emit(sessionId);
        const bOut = [];
        for (const g of cU.groups) {
          if (options.resumeOnlyGroupKey && g.key !== options.resumeOnlyGroupKey) continue;
          const r = await this.executeGroupStage(run, parentAgent, g, { stageTitle: '工程施工', promptContext: `【任务要求】\n${taskPrompt}\n\n【已认可设计方案】\n${designText}`, allowWrite: true, taskSignal });
          if (r.stopped) return run;
          if (r.text) bOut.push(r.text);
        }
        for (const ind of cU.inds) {
          if (options.resumeOnlyGroupKey) continue;
          const r = await this.executeIndependentStage(run, parentAgent, ind, { stageTitle: '工程施工', promptContext: `【任务要求】\n${taskPrompt}\n\n【已认可设计方案】\n${designText}`, allowWrite: true, taskSignal });
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
            const r = await this.executeGroupStage(run, parentAgent, g, { stageTitle: '施工审验', promptContext: `【已认可设计】\n${designText}\n\n【施工成果】\n${combinedBuild}`, isReview: true, taskSignal });
            if (r.stopped) return run;
            const dec = extractReviewDecision(r.text);
            g.reviewConclusion = dec.conclusion;
            bRevs.push(dec);
          }
          for (const ind of crU.inds) {
            const r = await this.executeIndependentStage(run, parentAgent, ind, { stageTitle: '施工审验', promptContext: `【已认可设计】\n${designText}\n\n【施工成果】\n${combinedBuild}`, isReview: true, taskSignal });
            if (r.stopped) return run;
            const dec = extractReviewDecision(r.text);
            ind.reviewConclusion = dec.conclusion;
            bRevs.push(dec);
          }
          const rejected = bRevs.find(d => d.conclusion === 'changes');
          if (rejected && attempt < 2) {
            await this.runSecretaryReport(run, parentAgent, { kind: 'stage', stageSummary: '施工审验发现问题，退回施工席返工。', details: rejected.summary });
            continue;
          }
        }
        break;
      }
    }

    const finalDeliverable = {
      id: `deliv-${run.round}`,
      version: run.constructionArtifact?.version || run.designArtifact?.version || `v${run.round}`,
      at: new Date().toISOString(),
      designText: run.designArtifact?.text || '',
      constructionText: run.constructionArtifact?.text || ''
    };
    run.deliverables.push(finalDeliverable);
    run.stage = 'awaiting-user-acceptance';
    run.stageLabel = '已交付主对话 · 等待用户验收';
    run.userAcceptanceStatus = 'awaiting-user';

    await this.runSecretaryReport(run, parentAgent, {
      kind: 'final',
      stageSummary: '本轮全部工作组与独立席已完成交付，现呈交完整成果并等待你验收。',
      details: [finalDeliverable.designText, finalDeliverable.constructionText].filter(Boolean).join('\n\n')
    });
    this.memory.appendRoleExperience('secretary', { projectId: run.taskId, summary: `完成任务「${taskPrompt.slice(0, 40)}」全流程阶段汇报与最终总结` });
    this.emit(sessionId);
    return run;
  }
}

