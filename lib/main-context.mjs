export const MAIN_CONTEXT_TOOL = Object.freeze({
  name: 'cabinet_read_main',
  description: '按消息 ID 或序号读取当前主对话的公开内容。仅本次获授权的组长或独立席可用。',
  parameters: {
    type: 'object',
    properties: {
      messageId: { type: 'string', minLength: 1 },
      seq: { type: 'integer', minimum: 0 }
    },
    additionalProperties: false
  }
});

function visibleText(message) {
  return (Array.isArray(message?.content) ? message.content : [])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim();
}

function collectPublicRows(parentAgent, run) {
  const session = parentAgent?.session;
  if (!session || !Array.isArray(session.surface?.nodes) || typeof session.snapshotEvents !== 'function') {
    return [];
  }
  const rows = [];
  for (const seq of session.surface.nodes) {
    if (!Number.isSafeInteger(seq) || seq < 0) continue;
    const event = session.snapshotEvents(seq, seq + 1).find(item => item?.seq === seq);
    if (!event || (event.type !== 'user/message' && event.type !== 'assistant/message')) continue;
    const message = typeof session.deriveEventMessage === 'function' ? session.deriveEventMessage(event) : event.data;
    const kind = message?.source?.kind;
    if (typeof message?.source?.taskId === 'string' && message.source.taskId !== run?.taskId) continue;
    const allowed = event.type === 'user/message'
      ? message?.role === 'user' && (kind === 'user' || (kind === 'cabinet-relay' && message.source.taskId === run?.taskId))
      : message?.role === 'assistant' && kind === 'model';
    if (!allowed) continue;
    const text = visibleText(message);
    if (!text) continue;
    rows.push({
      messageId: message.id || `seq-${seq}`,
      seq,
      role: message.role,
      kind: kind === 'cabinet-relay' ? 'upstream' : 'history',
      text
    });
  }
  return rows;
}

function isAuthorized(run, seat, role, groupKey, independentKey, phase) {
  if (!run || !seat || !role || !phase || run.stoppedAll) return false;
  if (groupKey) {
    const group = run.groups?.find(item => item.key === groupKey && item.role === role);
    return Boolean(group && !group.stopped && group.leaderId === seat.id && (phase === 'opening' || phase === 'formal'));
  }
  const ind = run.independents?.find(item => item.key === independentKey && item.id === seat.id && item.role === role);
  return Boolean(ind && phase === 'independent');
}

export class MainConversationContext {
  #scopes = new WeakMap();

  begin({ parentAgent, run, seat, role, groupKey = null, independentKey = null, phase = null } = {}) {
    const scope = {};
    this.#scopes.set(scope, {
      parentAgent,
      run,
      allowed: isAuthorized(run, seat, role, groupKey, independentKey, phase),
      closed: false
    });
    return scope;
  }

  canRead(scope) {
    const state = scope && this.#scopes.get(scope);
    return Boolean(state && !state.closed && state.allowed);
  }

  brief(scope) {
    const state = scope && this.#scopes.get(scope);
    if (!state || state.closed || !state.allowed) return '';
    const rows = collectPublicRows(state.parentAgent, state.run);
    if (!rows.length) return '';
    const recent = rows.slice(-6).map(r => `[seq=${r.seq} id=${r.messageId} ${r.role}] ${r.text.slice(0, 400)}`);
    return recent.join('\n');
  }

  read(scope, args = {}) {
    const state = scope && this.#scopes.get(scope);
    if (!state || state.closed || !state.allowed) {
      throw new Error('当前席位无权读取主对话');
    }
    const rows = collectPublicRows(state.parentAgent, state.run);
    const matched = args.messageId !== undefined
      ? rows.filter(r => r.messageId === args.messageId)
      : args.seq !== undefined
        ? rows.filter(r => r.seq === args.seq)
        : rows.slice(-6);
    const output = matched.length
      ? matched.map(r => `[seq=${r.seq} id=${r.messageId} ${r.role}]\n${r.text.slice(0, 1500)}`).join('\n\n')
      : '当前公开范围内未找到指定消息。';
    return { tool: MAIN_CONTEXT_TOOL.name, path: '', summary: '当前主对话公开文字', output };
  }

  close(scope) {
    const state = scope && this.#scopes.get(scope);
    if (state) state.closed = true;
  }
}
