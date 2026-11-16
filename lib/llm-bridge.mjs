import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';

function createSystemMessage(text) {
  return { role: 'system', content: [{ type: 'text', text: String(text ?? '') }] };
}

function createUserMessage({ content, source } = {}) {
  return { role: 'user', content: content ?? [], ...(source ? { source } : {}) };
}

function assistantMessage(provider, model, content, replayState) {
  return { id: `cab-assistant-${randomUUID()}`, role: 'assistant', content: structuredClone(content),
    source: { kind: 'model', provider, model, ...(replayState === undefined ? {} : { replayState: structuredClone(replayState) }) } };
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

export const CABINET_SEAT_PURPOSE = 'dsh-cabinet-seat';

const FINISH_REASONS = new Set(['stop', 'tool-calls', 'max-tokens', 'aborted', 'error']);

function responseDiagnostics(diagnostics, text = '') {
  return {
    visibleTextChunks: Number.isSafeInteger(diagnostics?.visibleTextChunks) && diagnostics.visibleTextChunks >= 0
      ? diagnostics.visibleTextChunks : String(text).trim() ? 1 : 0,
    finishReasons: Array.isArray(diagnostics?.finishReasons) && diagnostics.finishReasons.length
      ? diagnostics.finishReasons.slice(0, 16).map(reason => FINISH_REASONS.has(reason) ? reason : reason === 'missing' ? 'missing' : 'unknown')
      : ['missing']
  };
}

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
    this.disposed = false;
    this.disposal = null;
    this.sessionLogExclusion = typeof ctx?.inject === 'function'
      ? ctx.inject(['sessionLogDeepSeek'], scoped => {
        scoped.sessionLogDeepSeek.registerExclusion(request => request.purpose === CABINET_SEAT_PURPOSE);
      })
      : null;
    ctx?.effect?.(() => () => this.dispose(), 'cabinet seat request lifecycle');
  }

  dispose() {
    this.disposed = true;
    this.disposal ??= Promise.resolve(this.sessionLogExclusion?.dispose?.());
    return this.disposal;
  }

  async ensureSessionLogExclusion() {
    if (this.disposed) throw new Error('内阁席位调用已关闭');
    if (this.ctx?.get?.('sessionLogDeepSeek')) await this.sessionLogExclusion?.await?.();
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

  async invokeModel({ modelRef, systemPrompt, userPrompt, messages: priorMessages = null, tools = [], sessionId = 'cabinet-session', signal, onDelta, preserveModelIdentity = false }) {
    if (this.disposed) throw new Error('内阁席位调用已关闭');
    const resolved = await this.catalog.resolveModelRef(modelRef);
    if (!resolved) throw new Error('未找到可用模型，请在配置画布中重新选择');
    const provider = resolved.providerId;
    const model = resolved.modelId;
    if (preserveModelIdentity) {
      const [requestedProvider, requestedModel] = typeof modelRef === 'string' ? modelRef.split('::')
        : [modelRef?.providerId ?? modelRef?.provider, modelRef?.modelId ?? modelRef?.model];
      if (provider !== requestedProvider || model !== requestedModel) {
        throw Object.assign(new Error('所选秘书模型的提供方或模型标识已不可用，请明确选择可用模型后重试；未自动替换'),
          { code: 'SECRETARY_MODEL_CHANGED' });
      }
    }
    const budget = resolveContextBudget(resolved);
    const messages = priorMessages ? structuredClone(priorMessages) : [
      ...(systemPrompt?.trim() ? [createSystemMessage(systemPrompt.trim())] : []),
      createUserMessage({ content: [{ type: 'text', text: userPrompt }], source: { kind: 'user' } })
    ];

    const assertDispatchAllowed = () => {
      signal?.throwIfAborted?.();
      if (this.disposed) throw new Error('内阁席位调用已关闭');
    };
    const runCall = async () => {
      assertDispatchAllowed();
      await this.ensureSessionLogExclusion();
      assertDispatchAllowed();
      if (typeof this.options.customResponder === 'function') {
        const custom = await this.options.customResponder({ provider, model, reasoningEffort: resolved.reasoningEffort, systemPrompt, userPrompt, messages, tools, signal, purpose: CABINET_SEAT_PURPOSE });
        if (custom && typeof custom === 'object' && ('text' in custom || 'toolCalls' in custom)) {
          return { provider, model, reasoningEffort: resolved.reasoningEffort ?? null, text: String(custom.text ?? ''), toolCalls: custom.toolCalls ?? [], budget,
            messages, assistantMessage: assistantMessage(provider, model, custom.content ?? [
              ...(custom.text ? [{ type: 'text', text: String(custom.text) }] : []),
              ...(custom.toolCalls ?? []).map(call => ({ type: 'tool-call', id: call.id, name: call.name,
                arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments) }))
            ], custom.replayState),
            diagnostics: responseDiagnostics(custom.diagnostics, custom.text ?? '') };
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
          assertDispatchAllowed();
          if (err?.code !== 'NO_ADAPTER') {
            delete callConfig.reasoningEffort;
            delete callConfig.maxTokens;
            try { prepared = await llmSvc.prepareCall(callConfig, signal); } catch {}
          }
        }
        assertDispatchAllowed();
        if (prepared) {
          const reqOptions = { ...prepared.config, messages, tools, sessionId, signal, purpose: CABINET_SEAT_PURPOSE };
          const stream = prepared.stream(reqOptions);
          let text = '';
          const toolCalls = [];
          const toolCallsById = new Map();
          const responseBlocks = new Map();
          const closedBlocks = new Set();
          let replayState;
          const collectToolCall = (raw, legacy = false) => {
            const id = legacy ? raw.id ?? raw.toolCallId : raw.id;
            const name = legacy ? raw.name ?? raw.toolName : raw.name;
            let args = legacy ? raw.arguments ?? raw.input : raw.arguments;
            const invalid = () => Object.assign(new Error('模型返回的完整工具调用缺少有效 ID、名称或参数对象'), { code: 'CABINET_INVALID_TOOL_CALL' });
            if (typeof id !== 'string' || !id.trim() || typeof name !== 'string' || !name.trim()) throw invalid();
            if (typeof args === 'string') {
              try { args = JSON.parse(args); } catch { throw invalid(); }
            }
            if (!args || typeof args !== 'object' || Array.isArray(args)) throw invalid();
            try { args = structuredClone(args); } catch { throw invalid(); }
            const call = { id, name, arguments: args };
            const prior = toolCallsById.get(id);
            if (prior) {
              if (!isDeepStrictEqual(prior, call)) throw Object.assign(new Error('同一工具调用 ID 对应不同的完整调用内容'), { code: 'CABINET_TOOL_CALL_CONFLICT' });
              return prior;
            }
            toolCallsById.set(id, call);
            toolCalls.push(call);
            return call;
          };
          const diagnostics = { visibleTextChunks: 0, finishReasons: [] };
          for await (const chunk of stream) {
            signal?.throwIfAborted?.();
            const index = chunk.index ?? 'text';
            if (chunk.type === 'block-start' && !responseBlocks.has(index)) responseBlocks.set(index, { type: chunk.blockType,
              ...(['text', 'reasoning'].includes(chunk.blockType) ? { text: '' } : {}) });
            if ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && typeof chunk.text === 'string' && !closedBlocks.has(index)) {
              const type = chunk.type === 'text-delta' ? 'text' : 'reasoning';
              const block = responseBlocks.get(index) ?? { type, text: '' };
              block.text += chunk.text; responseBlocks.set(index, block);
            }
            if (chunk.type === 'block-end' && chunk.block) {
              const call = chunk.block.type === 'tool-call' ? collectToolCall(chunk.block) : null;
              const prior = responseBlocks.get(index);
              if (closedBlocks.has(index)) {
                if (call ? prior.type !== 'tool-call' || prior.id !== call.id : !isDeepStrictEqual(prior, chunk.block)) {
                  throw Object.assign(new Error('同一响应块位置对应不同的完整内容'), { code: 'CABINET_TOOL_CALL_CONFLICT' });
                }
              } else {
                responseBlocks.set(index, { ...structuredClone(chunk.block), ...(call && typeof chunk.block.arguments !== 'string'
                  ? { arguments: JSON.stringify(call.arguments) } : {}) });
                closedBlocks.add(index);
              }
            }
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
              text += chunk.text;
              if (chunk.text.trim()) diagnostics.visibleTextChunks += 1;
              onDelta?.(chunk.text, text);
            } else if (chunk.type === 'tool-call' || chunk.type === 'tool_call') {
              const call = collectToolCall(chunk, true);
              if (![...responseBlocks.values()].some(block => block.type === 'tool-call' && block.id === call.id)) {
                responseBlocks.set(`tool:${call.id}`, { type: 'tool-call', id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
              }
            } else if (chunk.type === 'finish') {
              if (chunk.replayState !== undefined) replayState = structuredClone(chunk.replayState);
              diagnostics.finishReasons.push(FINISH_REASONS.has(chunk.reason?.kind) ? chunk.reason.kind : 'unknown');
              if (chunk.reason?.kind === 'error') {
                throw Object.assign(new Error(chunk.reason?.failure?.message || '模型调用返回错误'), {
                  diagnostics: responseDiagnostics(diagnostics, text)
                });
              }
            }
          }
          const seenTools = new Set();
          const blocks = [...responseBlocks.values()];
          const kept = [];
          const content = blocks.filter((block, position) => {
            if (block.type !== 'tool-call') { kept.push(position); return true; }
            if (!toolCallsById.has(block.id) || seenTools.has(block.id)) return false;
            seenTools.add(block.id); kept.push(position); return true;
          });
          if (replayState?.blocks !== undefined) {
            if (!Array.isArray(replayState.blocks) || replayState.blocks.length !== blocks.length) {
              throw Object.assign(new Error('响应内容与 replay 块位置无法对应'), { code: 'CABINET_INVALID_RESPONSE_REPLAY' });
            }
            if (kept.length !== blocks.length) replayState = { ...replayState, blocks: kept.map(position => replayState.blocks[position]) };
          }
          const pairedCalls = content.filter(block => block.type === 'tool-call');
          if (pairedCalls.length !== toolCalls.length || toolCalls.some(call => !pairedCalls.some(block => block.id === call.id
            && block.name === call.name && isDeepStrictEqual(JSON.parse(block.arguments), call.arguments)))) {
            throw Object.assign(new Error('完整工具调用与 assistant 消息中的工具块不一致'), { code: 'CABINET_TOOL_CALL_CONFLICT' });
          }
          return { provider, model, reasoningEffort: prepared.config?.reasoningEffort ?? resolved.reasoningEffort ?? null, text: text.trim(), toolCalls, budget,
            messages, assistantMessage: assistantMessage(provider, model, content, replayState),
            diagnostics: responseDiagnostics(diagnostics, text) };
        }
      }

      throw new Error(`模型 ${provider}/${model} 暂不可用 · 请在 DSH 模型设置中检查连接或更换模型`);
    };

    return this.isLocalModel(provider, model) ? this.withLocalInferenceSlot(runCall) : runCall();
  }
}

