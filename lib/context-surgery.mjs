function nonNegativeSafeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

export function buildSessionSurfaceReplacementIntent(session, seq) {
  if (!nonNegativeSafeInt(seq)) {
    throw new TypeError(`无效的事件序号 seq: ${String(seq)}`);
  }
  const version = session?.header?.version;
  if (!nonNegativeSafeInt(version)) {
    throw new Error('当前会话缺少有效的格式版本号，无法执行上下文表面替换');
  }
  if (version <= 2) {
    return {
      surfaceOp: { op: 'replace', start: seq, end: seq },
      sourceEventSeqs: [seq]
    };
  }
  if (version === 3 || version === 4) {
    return {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq]
    };
  }
  throw new Error(`不支持的会话格式版本 v${version}，为避免损坏日志已中止操作`);
}

export function extractAssistantText(event) {
  if (!event || !event.data) return '';
  if (event.type === 'assistant/message') {
    const content = event.data?.message?.content;
    if (!Array.isArray(content)) return '';
    return content
      .filter(b => b?.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n')
      .trim();
  }
  if (event.type === 'plugin:cabinet-v2/presentation') {
    if (typeof event.data.text === 'string') return event.data.text.trim();
    if (Array.isArray(event.data.content)) {
      return event.data.content
        .filter(b => b?.type === 'text' && typeof b.text === 'string')
        .map(b => b.text)
        .join('\n')
        .trim();
    }
  }
  return '';
}

export function replaceAssistantMessageData(event, newText) {
  const cleanText = String(newText ?? '').trim();
  if (!cleanText) throw new Error('修订内容不能为空');
  if (!event || !event.data) throw new Error('目标事件数据无效');

  if (event.type === 'assistant/message') {
    const clone = JSON.parse(JSON.stringify(event.data));
    const msg = clone.message && typeof clone.message === 'object' ? clone.message : { role: 'assistant', content: [] };
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const preserved = [];
    let replaced = false;
    for (const block of blocks) {
      if (block?.type === 'text') {
        if (!replaced) {
          preserved.push({ type: 'text', text: cleanText });
          replaced = true;
        }
      } else {
        preserved.push(block);
      }
    }
    if (!replaced) preserved.push({ type: 'text', text: cleanText });
    msg.content = preserved;
    clone.message = msg;
    return clone;
  }

  if (event.type === 'plugin:cabinet-v2/presentation') {
    const clone = JSON.parse(JSON.stringify(event.data));
    clone.text = cleanText;
    if (Array.isArray(clone.content)) {
      clone.content = [{ type: 'text', text: cleanText }];
    }
    return clone;
  }

  throw new Error(`不支持修改的事件类型：${event.type}`);
}

export function buildPruneMap(events = []) {
  const map = new Map();
  for (const ev of events) {
    if (ev?.type !== 'plugin:cabinet-v2/message-prune' || !ev.data) continue;
    const seq = ev.data.targetSeq;
    if (!nonNegativeSafeInt(seq)) continue;
    map.set(seq, {
      targetSeq: seq,
      targetType: ev.data.targetType || 'assistant/message',
      messageId: ev.data.messageId || null,
      originalText: String(ev.data.originalText ?? ''),
      prunedText: String(ev.data.prunedText ?? ''),
      restored: ev.data.restored === true,
      at: ev.data.at || null
    });
  }
  return map;
}

export function listEditableMessages(events = []) {
  const pruneMap = buildPruneMap(events);
  const originalsBySeq = new Map();
  const latestTextBySeq = new Map();

  for (const ev of events) {
    if (!ev || (ev.type !== 'assistant/message' && ev.type !== 'plugin:cabinet-v2/presentation')) continue;
    const replacedSeq = Array.isArray(ev.sourceEventSeqs) && nonNegativeSafeInt(ev.sourceEventSeqs[0])
      ? ev.sourceEventSeqs[0]
      : null;
    if (replacedSeq !== null && originalsBySeq.has(replacedSeq)) {
      latestTextBySeq.set(replacedSeq, extractAssistantText(ev));
      continue;
    }
    if (!nonNegativeSafeInt(ev.seq)) continue;
    const text = extractAssistantText(ev);
    if (!text) continue;
    const title = ev.type === 'plugin:cabinet-v2/presentation'
      ? (ev.data?.title || ev.data?.groupLabel || '内阁汇报')
      : `AI 回复 #${ev.data?.turn ?? ev.seq}`;
    const messageId = ev.type === 'assistant/message'
      ? (ev.data?.message?.id || null)
      : (ev.data?.messageId || null);
    originalsBySeq.set(ev.seq, {
      seq: ev.seq,
      type: ev.type,
      messageId,
      title,
      turn: ev.data?.turn ?? null,
      time: ev.time || null,
      rawText: text
    });
    latestTextBySeq.set(ev.seq, text);
  }

  const rows = [];
  for (const [seq, orig] of originalsBySeq.entries()) {
    const prune = pruneMap.get(seq);
    const activePruned = prune && !prune.restored;
    const currentText = activePruned ? prune.prunedText : (latestTextBySeq.get(seq) ?? orig.rawText);
    rows.push({
      seq,
      type: orig.type,
      messageId: orig.messageId,
      title: orig.title,
      turn: orig.turn,
      time: orig.time,
      currentText,
      originalText: prune ? prune.originalText : orig.rawText,
      pruned: Boolean(activePruned),
      prunedAt: prune?.at || null
    });
  }
  return rows.reverse();
}

export async function pruneMessageInSession({ session, targetSeq, newText, appendPluginRecord, namespace, run = null }) {
  if (!session || typeof session.snapshotEvents !== 'function' || typeof session.append !== 'function') {
    throw new Error('当前会话尚未就绪或不支持上下文写入');
  }
  const cleanText = String(newText ?? '').trim();
  if (!cleanText) throw new Error('修订后的内容不能为空');

  const events = session.snapshotEvents() ?? [];
  const targetEvent = events.find(ev => ev?.seq === targetSeq && !ev.surfaceOp);
  if (!targetEvent) {
    throw new Error(`未找到序号为 ${targetSeq} 的原始消息事件`);
  }
  if (targetEvent.type !== 'assistant/message' && targetEvent.type !== 'plugin:cabinet-v2/presentation') {
    throw new Error(`仅支持剪枝修改 AI 回复或内阁汇报（当前类型：${targetEvent.type}）`);
  }

  const pruneMap = buildPruneMap(events);
  const existingPrune = pruneMap.get(targetSeq);
  const originalText = existingPrune ? existingPrune.originalText : extractAssistantText(targetEvent);
  const at = new Date().toISOString();

  if (targetEvent.type === 'assistant/message') {
    const intent = buildSessionSurfaceReplacementIntent(session, targetSeq);
    const replacedData = replaceAssistantMessageData(targetEvent, cleanText);
    await session.append(targetEvent.type, replacedData, intent);
  } else if (targetEvent.type === 'plugin:cabinet-v2/presentation') {
    try {
      const intent = buildSessionSurfaceReplacementIntent(session, targetSeq);
      const replacedData = replaceAssistantMessageData(targetEvent, cleanText);
      await session.append(targetEvent.type, replacedData, intent);
    } catch {}
    if (run && targetEvent.data?.messageId) {
      const mid = targetEvent.data.messageId;
      if (Array.isArray(run.secretary?.reports)) {
        for (const r of run.secretary.reports) {
          if (r.id === mid) r.text = cleanText;
        }
      }
      if (Array.isArray(run.deliverables)) {
        for (const d of run.deliverables) {
          if (d.id === mid || d.messageId === mid) d.text = cleanText;
        }
      }
    }
  }

  await appendPluginRecord(session, namespace + 'message-prune', {
    schemaVersion: 1,
    targetSeq,
    targetType: targetEvent.type,
    messageId: targetEvent.data?.message?.id || targetEvent.data?.messageId || null,
    originalText,
    prunedText: cleanText,
    restored: false,
    at
  });

  return { ok: true, targetSeq, originalText, prunedText: cleanText, at };
}


export async function restoreMessageInSession({ session, targetSeq, appendPluginRecord, namespace, run = null }) {
  if (!session || typeof session.snapshotEvents !== 'function' || typeof session.append !== 'function') {
    throw new Error('当前会话尚未就绪或不支持上下文写入');
  }
  const events = session.snapshotEvents() ?? [];
  const targetEvent = events.find(ev => ev?.seq === targetSeq && !ev.surfaceOp);
  if (!targetEvent) throw new Error(`未找到序号为 ${targetSeq} 的原始消息事件`);

  const pruneMap = buildPruneMap(events);
  const existingPrune = pruneMap.get(targetSeq);
  if (!existingPrune || existingPrune.restored) {
    return { ok: true, targetSeq, restored: true, noop: true };
  }

  const originalText = existingPrune.originalText || extractAssistantText(targetEvent);
  const at = new Date().toISOString();

  if (targetEvent.type === 'assistant/message') {
    const intent = buildSessionSurfaceReplacementIntent(session, targetSeq);
    const restoredData = JSON.parse(JSON.stringify(targetEvent.data));
    await session.append(targetEvent.type, restoredData, intent);
  } else if (targetEvent.type === 'plugin:cabinet-v2/presentation') {
    try {
      const intent = buildSessionSurfaceReplacementIntent(session, targetSeq);
      const restoredData = JSON.parse(JSON.stringify(targetEvent.data));
      await session.append(targetEvent.type, restoredData, intent);
    } catch {}
    if (run && targetEvent.data?.messageId) {
      const mid = targetEvent.data.messageId;
      if (Array.isArray(run.secretary?.reports)) {
        for (const r of run.secretary.reports) {
          if (r.id === mid) r.text = originalText;
        }
      }
      if (Array.isArray(run.deliverables)) {
        for (const d of run.deliverables) {
          if (d.id === mid || d.messageId === mid) d.text = originalText;
        }
      }
    }
  }

  await appendPluginRecord(session, namespace + 'message-prune', {
    schemaVersion: 1,
    targetSeq,
    targetType: targetEvent.type,
    messageId: targetEvent.data?.message?.id || targetEvent.data?.messageId || null,
    originalText,
    prunedText: originalText,
    restored: true,
    at
  });

  return { ok: true, targetSeq, originalText, restored: true, at };
}

