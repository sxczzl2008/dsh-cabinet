function createSystemMessage(text) {
  return { role: 'system', content: [{ type: 'text', text: String(text ?? '') }] };
}

function createUserMessage({ content, source } = {}) {
  return { role: 'user', content: content ?? [], ...(source ? { source } : {}) };
}

export const CONTEXT_LIMITS = Object.freeze({
  MIN: 8192,
  MAX: 1048576,
  DEFAULT: 245000,
  HALLUCINATION_WARN_THRESHOLD: 262144,
  MIN_GEN_BUDGET: 1024,
  DEFAULT_GEN_BUDGET: 8192,
  MAX_GEN_BUDGET: 65536
});

export function resolveContextBudget(modelInfo = {}) {
  let hardCap = modelInfo.contextWindow ?? CONTEXT_LIMITS.DEFAULT;
  hardCap = Math.max(CONTEXT_LIMITS.MIN, Math.min(CONTEXT_LIMITS.MAX, hardCap));
  const maxOutputTokens = Math.max(CONTEXT_LIMITS.MIN_GEN_BUDGET, Math.min(CONTEXT_LIMITS.MAX_GEN_BUDGET, modelInfo.maxOutputTokens ?? CONTEXT_LIMITS.DEFAULT_GEN_BUDGET));
  const maxInputChars = Math.max(16384, hardCap - maxOutputTokens);
  return {
    hardCap,
    maxOutputTokens,
    maxInputChars,
    hallucinationWarning: hardCap > CONTEXT_LIMITS.HALLUCINATION_WARN_THRESHOLD ? '当前上下文超过 262k，可能增加幻觉风险' : null
  };
}

export function trimMaterialsToBudget({ systemText = '', taskGoal = '', stageMaterials = [], userGuidance = '', maxInputChars = 220000 }) {
  const fixedHeader = [
    taskGoal ? `【任务目标】\n${taskGoal.trim()}` : '',
    userGuidance ? `【最新补充指令】\n${userGuidance.trim()}` : ''
  ].filter(Boolean).join('\n\n');
  let remaining = Math.max(4096, maxInputChars - systemText.length - fixedHeader.length - 1024);
  const kept = [];
  for (let i = stageMaterials.length - 1; i >= 0; i--) {
    const item = stageMaterials[i];
    const block = `【${item.title || '阶段材料'}】\n${String(item.content ?? '').trim()}`;
    if (block.length <= remaining) {
      kept.unshift(block);
      remaining -= block.length;
    } else if (remaining > 600) {
      kept.unshift(block.slice(0, remaining - 80) + '\n…[已按上下文窗口上限保留核心摘要，完整文件可通过工具读取]');
      remaining = 0;
      break;
    } else break;
  }
  const userPrompt = [fixedHeader, ...kept].filter(Boolean).join('\n\n');
  return { systemText, userPrompt, totalChars: systemText.length + userPrompt.length, trimmed: kept.length < stageMaterials.length };
}

export class LlmBridge {
  constructor(ctx, catalogService, options = {}) {
    this.ctx = ctx;
    this.catalog = catalogService;
    this.options = options;
    this.localSlotQueue = Promise.resolve();
  }

  isLocalModel(providerId, modelId) {
    const p = String(providerId ?? '').toLowerCase();
    const m = String(modelId ?? '').toLowerCase();
    return p.includes('local') || p.includes('strata') || m.includes('local') || m.includes('gguf');
  }

  async withLocalInferenceSlot(fn) {
    const prev = this.localSlotQueue;
    let release;
    this.localSlotQueue = new Promise(resolve => { release = resolve; });
    await prev.catch(() => {});
    try { return await fn(); } finally { release(); }
  }

  async invokeModel({ modelRef, systemPrompt, userPrompt, tools = [], sessionId = 'cabinet-session', signal, onDelta }) {
    const resolved = await this.catalog.resolveModelRef(modelRef);
    if (!resolved) throw new Error('未找到可用模型，请在配置画布中重新选择');
    const provider = resolved.providerId;
    const model = resolved.modelId;
    const budget = resolveContextBudget(resolved);

    const runCall = async () => {
      signal?.throwIfAborted?.();
      if (typeof this.options.customResponder === 'function') {
        const custom = await this.options.customResponder({ provider, model, reasoningEffort: resolved.reasoningEffort, systemPrompt, userPrompt, tools, signal });
        if (custom && typeof custom === 'object' && ('text' in custom || 'toolCalls' in custom)) {
          return { provider, model, reasoningEffort: resolved.reasoningEffort ?? null, text: String(custom.text ?? ''), toolCalls: custom.toolCalls ?? [], budget };
        }
      }

      let llmSvc = null;
      try { llmSvc = this.ctx?.get?.('llm') ?? this.ctx?.llm; } catch { try { llmSvc = this.ctx?.get?.('llm'); } catch {} }
      if (llmSvc?.prepareCall) {
        const callConfig = {
          provider, model,
          maxTokens: budget.maxOutputTokens,
          ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {})
        };
        let prepared = null;
        try {
          prepared = await llmSvc.prepareCall(callConfig, signal);
        } catch (err) {
          if (err?.code !== 'NO_ADAPTER') {
            delete callConfig.reasoningEffort;
            delete callConfig.maxTokens;
            try { prepared = await llmSvc.prepareCall(callConfig, signal); } catch {}
          }
        }
        if (prepared) {
          const messages = [];
          if (systemPrompt?.trim()) messages.push(createSystemMessage(systemPrompt.trim()));
          messages.push(createUserMessage({ content: [{ type: 'text', text: userPrompt }], source: { kind: 'user' } }));
          const reqOptions = { ...prepared.config, messages, toolHistory: [], ...(tools.length ? { tools } : {}), sessionId, signal };
          const stream = prepared.stream(reqOptions);
          let text = '';
          const toolCalls = [];
          for await (const chunk of stream) {
            signal?.throwIfAborted?.();
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
              text += chunk.text;
              onDelta?.(chunk.text, text);
            } else if (chunk.type === 'tool-call' || chunk.type === 'tool_call') {
              toolCalls.push({
                id: chunk.id ?? chunk.toolCallId ?? `call-${toolCalls.length + 1}`,
                name: chunk.name ?? chunk.toolName,
                arguments: typeof chunk.arguments === 'string'
                  ? (() => { try { return JSON.parse(chunk.arguments); } catch { return {}; } })()
                  : (chunk.arguments ?? chunk.input ?? {})
              });
            } else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
              throw new Error(chunk.reason?.failure?.message || '模型调用返回错误');
            }
          }
          return { provider, model, reasoningEffort: prepared.config?.reasoningEffort ?? resolved.reasoningEffort ?? null, text: text.trim(), toolCalls, budget };
        }
      }

      throw new Error(`模型 ${provider}/${model} 暂不可用 · 请在 DSH 模型设置中检查连接或更换模型`);
    };

    return this.isLocalModel(provider, model) ? this.withLocalInferenceSlot(runCall) : runCall();
  }
}

