import crypto from 'node:crypto';

function extractTextFromBlocks(blocks = []) {
  return (Array.isArray(blocks) ? blocks : [])
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim();
}

export function isLocalModel(providerId, modelId) {
  const p = String(providerId ?? '').toLowerCase();
  const m = String(modelId ?? '').toLowerCase();
  return p.includes('local') || p.includes('strata') || m.includes('local') || m.includes('gguf');
}

export class TeamRuntime {
  constructor(ctx, memoryRouter, isOrdinaryPostCabinet = null) {
    this.ctx = ctx;
    this.memory = memoryRouter;
    this.isOrdinaryPostCabinet = isOrdinaryPostCabinet;
    this.seatBindings = new Map();
    this.usedNames = new Map();
    this.ownedChildIds = new Set();
    this.localSlotQueue = Promise.resolve();
    this.disposers = [];
    this.setupHooks();
  }

  setupHooks() {
    if (!this.ctx) return;
    if (this.ctx.systemPrompt?.context) {
      try {
        const off = this.ctx.systemPrompt.context({
          name: 'dsh-cabinet:seat-context',
          order: 850,
          text: (context) => {
            const agent = context?.agent;
            const sid = agent?.id;
            const binding = sid ? this.seatBindings.get(sid) : null;
            if (binding) {
              const memCtx = this.memory?.formatPromptContext({
                role: binding.role,
                providerId: binding.providerId,
                modelId: binding.modelId,
                projectId: binding.taskId
              });
              const lines = [
                `你是内阁中的「${binding.seatLabel}」，当前担任职责：${binding.roleBadge}。`,
                binding.allowWrite
                  ? '本席位处于可写施工模式，可按任务要求读写工作区文件或执行验证命令（Windows 环境请使用 PowerShell 语法）。'
                  : '本席位处于只读审定/设计模式，严禁修改、创建或删除工作区文件。',
                '各席位之间的传话、轮次推进与任务板更新均由内阁编排器自动完成。请直接输出你的本轮发言或成果，严禁自行调用 list_agents、send_message、subagent、subagent_fork 或任务板工具去联系队友或派发任务。',
                '请严格围绕本轮提示词给出的用户需求与前序成果展开工作；除非用户任务明确要求读写工作区已有代码或文档，否则不要自行翻找工作区里与当前任务无关的历史文件，也不要把轻量对话或架构验证题强行扩写成形式化合规审计。'
              ];
              if (memCtx?.promptBlock) lines.push('', memCtx.promptBlock);
              return lines.join('\n');
            }
            if (agent && typeof this.isOrdinaryPostCabinet === 'function' && this.isOrdinaryPostCabinet(agent)) {
              return this.buildPostCabinetPrompt(agent);
            }
            return '';
          }
        });
        if (typeof off === 'function') this.disposers.push(off);
      } catch {}
    }

    if (typeof this.ctx.inject === 'function') {
      try {
        const off = this.ctx.inject(['sessionLogDeepSeek'], scoped => {
          scoped.sessionLogDeepSeek?.registerExclusion?.(req => req.purpose === 'dsh-cabinet-seat');
        });
        if (off?.dispose) this.disposers.push(() => off.dispose());
      } catch {}
    }
  }

  dispose() {
    while (this.disposers.length) {
      try { this.disposers.pop()(); } catch {}
    }
    this.seatBindings.clear();
    this.usedNames.clear();
    this.ownedChildIds.clear();
  }

  buildPostCabinetPrompt(agent) {
    const base = [
      '【系统状态：当前对话已退出内阁多模型模式，恢复为普通单模型直接对答。请勿扮演任何内阁席位、请勿继续报数，直接正常回复用户最新消息。】'
    ];
    const events = agent?.session?.snapshotEvents?.() ?? [];
    let lastCabinetStartIdx = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.type === 'plugin:cabinet-v2/transition' && ev.data?.mode === 'cabinet' && ev.data?.config) {
        lastCabinetStartIdx = i;
        break;
      }
    }
    if (lastCabinetStartIdx < 0) return base.join('\n');

    const slice = events.slice(lastCabinetStartIdx);
    const promptEv = slice.find(ev => ev.type === 'plugin:cabinet-v2/user-prompt');
    const subagents = slice.filter(ev => ev.type === 'subagent/catalog' && ev.data?.childId);
    const presentations = slice.filter(ev => ev.type === 'plugin:cabinet-v2/presentation' && ev.data?.text);

    const lines = [
      ...base,
      '',
      '【本对话最近一次内阁协作的真实只读归档（以本段为准，切勿把工作区里旧文件误认为本次内阁结果）】'
    ];
    if (promptEv?.data?.text) {
      lines.push(`- 本次内阁初始任务：${String(promptEv.data.text).trim().slice(0, 500)}`);
    }
    if (subagents.length) {
      lines.push(`- 本次内阁产生的独立子会话（共 ${subagents.length} 个）：`);
      for (const s of subagents) {
        lines.push(`  * ${s.data.label || s.data.name}（name: ${s.data.name}, sessionId: ${s.data.childId}）`);
      }
    }
    if (presentations.length) {
      const latestPres = presentations.at(-1);
      lines.push(`- 主对话最终呈交结论（${latestPres.data.title || latestPres.data.phase || '汇报'}）：`);
      lines.push(String(latestPres.data.text).trim().slice(0, 2600));
    } else {
      lines.push('- 本次内阁尚未输出最终呈交结论（可能中途手动退出或未完成）。');
    }
    return lines.join('\n');
  }

  isOwnedChild(childId) {
    return Boolean(childId && this.ownedChildIds.has(childId));
  }

  allocateUniqueName(rootAgent, requestedName) {
    const raw = String(requestedName || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    let base = (/^[a-z]/.test(raw) ? raw : `seat-${raw || 'x'}`).slice(0, 32);
    if (base === 'lead') base = 'seat-lead';

    const rootId = rootAgent?.id || 'default';
    let memSet = this.usedNames.get(rootId);
    if (!memSet) {
      memSet = new Set();
      this.usedNames.set(rootId, memSet);
    }
    const taken = new Set(memSet);
    for (const ev of rootAgent?.session?.snapshotEvents?.() ?? []) {
      if (ev.type === 'subagent/catalog' && typeof ev.data?.name === 'string') {
        taken.add(ev.data.name);
      }
    }

    let candidate = base;
    let seq = 2;
    while (taken.has(candidate)) {
      const suffix = `-${seq++}`;
      candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    }
    memSet.add(candidate);
    return candidate;
  }

  async withLocalInferenceSlot(fn) {
    const prev = this.localSlotQueue;
    let release;
    this.localSlotQueue = new Promise(resolve => { release = resolve; });
    await prev.catch(() => {});
    try { return await fn(); } finally { release(); }
  }

  async setTeamEnabled(rootAgent, enabled) {
    const teams = this.ctx?.get?.('agentTeams') ?? this.ctx?.agentTeams;
    if (!teams || !rootAgent) return false;
    try {
      if (teams.isEnabled(rootAgent) !== Boolean(enabled)) {
        await teams.setEnabled(rootAgent, Boolean(enabled));
      }
      return true;
    } catch {
      return false;
    }
  }

  async ensureTeamEnabled(rootAgent) {
    return this.setTeamEnabled(rootAgent, true);
  }

  async createBoardTask(rootAgent, { subject, description, blockedBy = [] }) {
    const teams = this.ctx?.get?.('agentTeams') ?? this.ctx?.agentTeams;
    if (!teams || !rootAgent) return null;
    try {
      return await teams.createTask(rootAgent, { subject, description, blockedBy });
    } catch {
      return null;
    }
  }

  async updateBoardTask(rootAgent, taskId, action, extra = {}) {
    const teams = this.ctx?.get?.('agentTeams') ?? this.ctx?.agentTeams;
    if (!teams || !rootAgent || !taskId) return null;
    try {
      let latest = teams.getTask(rootAgent, taskId);
      if (action === 'claim') {
        if (latest.status === 'in_progress') return latest;
        if (latest.status === 'completed') {
          latest = await teams.updateTask(rootAgent, {
            taskId,
            expectedRevision: latest.revision,
            action: 'reopen'
          });
        }
      } else if (action === 'reopen' && latest.status !== 'completed') {
        return latest;
      } else if (action === 'complete' && latest.status !== 'in_progress') {
        return latest;
      }
      return await teams.updateTask(rootAgent, {
        taskId,
        expectedRevision: latest.revision,
        action,
        ...extra
      });
    } catch {
      return null;
    }
  }

  async runSeatTurn({
    rootAgent,
    existingChildId = null,
    name,
    label,
    role,
    roleBadge,
    seatLabel,
    taskId,
    model,
    prompt,
    allowWrite = false,
    outputSchema = undefined,
    signal
  }) {
    const subagents = this.ctx?.get?.('subagents') ?? this.ctx?.subagents;
    if (!subagents) throw new Error('宿主未挂载官方 @deepseek-ai/dsh-subagent 服务');

    const runCall = async () => {
      signal?.throwIfAborted?.();
      const agentOptions = {
        provider: model.providerId,
        model: model.modelId,
        ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {})
      };

      const bindingInfo = {
        role,
        roleBadge,
        seatLabel,
        providerId: model.providerId,
        modelId: model.modelId,
        allowWrite,
        taskId
      };

      if (!existingChildId || outputSchema !== undefined) {
        const reservedChildId = crypto.randomUUID();
        const uniqueName = this.allocateUniqueName(rootAgent, outputSchema !== undefined && existingChildId ? `${name}-verdict` : name);
        this.seatBindings.set(reservedChildId, bindingInfo);
        this.ownedChildIds.add(reservedChildId);
        let activation;
        try {
          activation = await subagents.startActivation({
            childId: reservedChildId,
            provider: 'spawn',
            parent: rootAgent,
            name: uniqueName,
            label,
            prompt: [{ type: 'text', text: prompt }],
            agentOptions,
            ...(outputSchema !== undefined ? { outputSchema } : {}),
            delivery: 'caller',
            signal
          });
        } catch (err) {
          this.seatBindings.delete(reservedChildId);
          this.ownedChildIds.delete(reservedChildId);
          throw err;
        }
        this.ownedChildIds.add(activation.childId);
        const res = await activation.result;
        if (res.stopReason === 'error') {
          throw new Error(res.diagnostic || '席位模型执行返回错误');
        }
        if (res.stopReason === 'aborted') {
          throw new Error('TASK_STOPPED');
        }
        return {
          childId: activation.childId,
          name: activation.name,
          text: extractTextFromBlocks(res.output),
          structured: res.structured ?? null
        };
      }

      this.seatBindings.set(existingChildId, bindingInfo);
      this.ownedChildIds.add(existingChildId);

      const sendSignal = signal ?? new AbortController().signal;
      let offEnd = null;
      let onAbort = null;
      const waitResult = new Promise((resolve, reject) => {
        let settled = false;
        onAbort = () => {
          if (settled) return;
          settled = true;
          offEnd?.();
          reject(new Error('TASK_STOPPED'));
        };
        sendSignal.addEventListener('abort', onAbort, { once: true });
        offEnd = this.ctx.on('subagent/end', info => {
          if (settled || info?.id !== existingChildId) return;
          settled = true;
          sendSignal.removeEventListener('abort', onAbort);
          offEnd?.();
          if (info.stopReason === 'error') {
            reject(new Error('席位模型继续执行时返回错误'));
            return;
          }
          if (info.stopReason === 'aborted') {
            reject(new Error('TASK_STOPPED'));
            return;
          }
          resolve({
            childId: existingChildId,
            name,
            text: extractTextFromBlocks(info.lastAssistantMessage),
            structured: null
          });
        });
      });

      try {
        await subagents.sendMessage(
          rootAgent,
          existingChildId,
          [{ type: 'text', text: prompt }],
          { signal: sendSignal }
        );
      } catch (err) {
        if (onAbort) sendSignal.removeEventListener('abort', onAbort);
        offEnd?.();
        throw err;
      }
      return await waitResult;
    };

    return isLocalModel(model.providerId, model.modelId)
      ? this.withLocalInferenceSlot(runCall)
      : runCall();
  }

  async sendGuidance(sessionId, childId, text, signal) {
    const subagents = this.ctx?.get?.('subagents') ?? this.ctx?.subagents;
    const rootAgent = this.ctx?.get?.('agents')?.get(sessionId);
    if (!subagents || !rootAgent || !childId || !String(text || '').trim()) return;
    await subagents.sendMessage(
      rootAgent,
      childId,
      [{ type: 'text', text: `【用户补充指令】\n${String(text).trim()}` }],
      { signal: signal ?? new AbortController().signal }
    );
  }

  interruptSeats(childIds = []) {
    const subagents = this.ctx?.get?.('subagents') ?? this.ctx?.subagents;
    if (!subagents) return;
    for (const id of childIds) {
      if (id) {
        try { subagents.interrupt(id, { kind: 'user' }); } catch {}
      }
    }
  }

  async appendMainAssistantMessage(parentAgent, {
    messageId = `cab-msg-${crypto.randomUUID()}`,
    title,
    groupLabel,
    actorLabel,
    role,
    participantId,
    providerId,
    modelId,
    phase,
    groupKey = null,
    formalVersion = null,
    text,
    taskId = null
  }) {
    const bodyText = String(text ?? '').trim();
    if (!parentAgent?.session || !bodyText) return null;

    const snapshot = parentAgent.session.snapshotEvents();
    if (!snapshot.some(ev => ev.type === 'plugin:cabinet-v2/presentation' && ev.data?.messageId === messageId)) {
      const api = await import('@deepseek-ai/dsh-session');
      await api.appendPluginRecord(parentAgent.session, 'plugin:cabinet-v2/presentation', {
        messageId,
        sourceId: messageId,
        sessionId: parentAgent.id,
        title: title || '',
        groupLabel: groupLabel || '',
        actorLabel: actorLabel || '',
        role: role || '',
        participantId: participantId || '',
        provider: providerId || 'cabinet',
        model: modelId || 'cabinet',
        phase: phase || role || '',
        groupKey,
        formalVersion,
        taskId,
        text: bodyText,
        at: new Date().toISOString()
      });
    }

    const sessions = this.ctx?.get?.('sessions') ?? this.ctx?.sessions;
    if (typeof sessions?.flush === 'function') {
      await sessions.flush(parentAgent.session);
    }
    return { ok: true, messageId };
  }
}
