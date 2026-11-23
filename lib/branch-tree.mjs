import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const CABINET_BRANCH_PATCH = Symbol.for('dsh-cabinet.branch-cascade.patch');

function nonNegInt(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && !Object.is(v, -0);
}

export function extractUserPromptText(event) {
  if (!event || !event.data) return '';
  if (event.type === 'plugin:cabinet-v2/user-prompt') {
    return String(event.data.text ?? '').trim();
  }
  if (event.type === 'user/message') {
    const c = event.data.content;
    if (typeof c === 'string') return c.trim();
    if (Array.isArray(c)) {
      return c.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim();
    }
  }
  return '';
}

export function listForkableUserMessages(events = [], { ascending = false } = {}) {
  const out = [];
  for (const ev of events) {
    if (!ev || !nonNegInt(ev.seq)) continue;
    if (ev.type === 'user/message') {
      const kind = ev.data?.source?.kind;
      if (kind && kind !== 'user') continue;
      const text = extractUserPromptText(ev);
      if (!text) continue;
      out.push({
        seq: ev.seq,
        id: ev.data?.id || null,
        type: ev.type,
        text,
        time: ev.time || null,
        mode: 'ordinary'
      });
    } else if (ev.type === 'plugin:cabinet-v2/user-prompt') {
      const text = extractUserPromptText(ev);
      if (!text) continue;
      out.push({
        seq: ev.seq,
        id: ev.data?.id || null,
        type: ev.type,
        text,
        time: ev.time || null,
        mode: 'cabinet'
      });
    }
  }
  return ascending ? out : out.reverse();
}

/**
 * 截取 anchorSeq 所在那一轮（turn）之前的干净闭合前缀：
 * 向前找到包含 anchorSeq 的 turn/start，若紧邻其前是压入该轮消息的 agent/inbox/spliced 也一并排除，
 * 避免新分支末尾残留未闭合的 turn/start 或 step/start。
 */
export function sliceCleanPrefixEvents(events = [], anchorSeq) {
  const body = events.filter(ev => ev && ev.type !== 'session' && nonNegInt(ev.seq));
  let cutIdx = body.findIndex(ev => ev.seq >= anchorSeq);
  if (cutIdx < 0) cutIdx = body.length;

  // 在 [0, cutIdx) 中回溯，检查是否正处于一个尚未闭合的 turn 内部
  let openTurnStartIdx = -1;
  for (let i = cutIdx - 1; i >= 0; i--) {
    const t = body[i].type;
    if (t === 'turn/end') break;
    if (t === 'turn/start') {
      openTurnStartIdx = i;
      break;
    }
  }
  if (openTurnStartIdx >= 0) {
    cutIdx = openTurnStartIdx;
    // 紧贴 turn/start 前面为本轮入队用户消息的 agent/inbox/spliced 也应裁掉
    while (cutIdx > 0 && body[cutIdx - 1].type === 'agent/inbox/spliced') {
      cutIdx--;
    }
  }

  return body.slice(0, cutIdx);
}

export function resolveCabinetStateBeforeSeq(events = [], anchorSeq, normalizeConfig) {
  let mode = 'ordinary';
  let config = null;
  for (const ev of events) {
    if (!ev || !nonNegInt(ev.seq) || ev.seq >= anchorSeq) break;
    if (ev.type === 'plugin:cabinet-v2/transition' && ev.data) {
      if (ev.data.associationDetached === true || ev.data.config === null) {
        mode = 'ordinary';
        config = null;
      } else if (ev.data.config) {
        mode = ev.data.mode || 'cabinet';
        config = typeof normalizeConfig === 'function' ? normalizeConfig(ev.data.config, 'task') : ev.data.config;
      }
    }
  }
  return { mode, config };
}

export class BranchTreeStore {
  constructor(dataRoot) {
    this.file = path.join(path.resolve(dataRoot), 'branch-trees.json');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) {
      fs.writeFileSync(this.file, JSON.stringify({ trees: {} }, null, 2) + '\n', 'utf8');
    }
  }

  read() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { trees: raw?.trees && typeof raw.trees === 'object' ? raw.trees : {} };
    } catch {
      return { trees: {} };
    }
  }

  write(data) {
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }

  findTreeBySession(sessionId) {
    const data = this.read();
    for (const [rootId, tree] of Object.entries(data.trees)) {
      if (rootId === sessionId || (tree.nodes || []).some(n => n.sessionId === sessionId)) {
        return { rootId, tree };
      }
    }
    return null;
  }

  recordBranch({
    sourceSessionId,
    branchSessionId,
    anchorSeq,
    anchorMessageId = null,
    branchMessageId = null,
    prefixEventCount = null,
    promptText,
    title,
    mode = 'ordinary'
  }) {
    const data = this.read();
    let rootId = sourceSessionId;
    let tree = null;
    for (const [rid, t] of Object.entries(data.trees)) {
      if (rid === sourceSessionId || (t.nodes || []).some(n => n.sessionId === sourceSessionId)) {
        rootId = rid;
        tree = t;
        break;
      }
    }
    const now = new Date().toISOString();
    if (!tree) {
      tree = {
        rootSessionId: rootId,
        createdAt: now,
        nodes: [{
          sessionId: rootId,
          parentSessionId: null,
          anchorSeq: null,
          forkPointId: null,
          branchMessageId: null,
          title: '原主对话',
          promptPreview: '',
          mode,
          createdAt: now
        }]
      };
    }

    // 若用户正在编辑一条本身就是从某分叉点创建出来的消息，复用同一个 forkPointId 让兄弟分支串在同一组 ◀ X / Y ▶ 里
    const sourceNode = (tree.nodes || []).find(n => n.sessionId === sourceSessionId);
    let forkPointId = null;
    if (
      sourceNode?.forkPointId
      && ((anchorMessageId && sourceNode.branchMessageId && anchorMessageId === sourceNode.branchMessageId)
        || (nonNegInt(sourceNode.branchAnchorSeq) && sourceNode.branchAnchorSeq === anchorSeq))
    ) {
      forkPointId = sourceNode.forkPointId;
    } else {
      const existingSibling = (tree.nodes || []).find(
        n => n.parentSessionId === sourceSessionId && n.anchorSeq === anchorSeq && n.forkPointId
      );
      forkPointId = existingSibling?.forkPointId || `fp::${sourceSessionId}::${anchorSeq}`;
    }

    const clean = String(promptText || '').replace(/\s+/g, ' ').trim();
    const chars = Array.from(clean);
    const preview = chars.slice(0, 20).join('') + (chars.length > 20 ? '…' : '');
    tree.nodes.push({
      sessionId: branchSessionId,
      parentSessionId: sourceSessionId,
      anchorSeq,
      anchorMessageId: anchorMessageId || null,
      branchMessageId: branchMessageId || null,
      branchAnchorSeq: null,
      prefixEventCount: nonNegInt(prefixEventCount) ? prefixEventCount : null,
      forkPointId,
      title: title || `分支 ${tree.nodes.length}`,
      promptPreview: preview,
      mode,
      createdAt: now
    });
    data.trees[rootId] = tree;
    this.write(data);
    return tree;
  }

  updateBranchAnchorSeq(branchSessionId, branchAnchorSeq, branchMessageId = null) {
    if (!branchSessionId || !nonNegInt(branchAnchorSeq)) return;
    const data = this.read();
    for (const tree of Object.values(data.trees)) {
      const node = (tree.nodes || []).find(n => n.sessionId === branchSessionId);
      if (node) {
        node.branchAnchorSeq = branchAnchorSeq;
        if (branchMessageId) node.branchMessageId = branchMessageId;
        this.write(data);
        return;
      }
    }
  }

  removeBranchNode(sessionId) {
    const data = this.read();
    for (const [rootId, tree] of Object.entries(data.trees)) {
      if (rootId === sessionId) {
        delete data.trees[rootId];
        this.write(data);
        return { removedRoot: true, removedIds: (tree.nodes || []).map(n => n.sessionId) };
      }
      const idx = (tree.nodes || []).findIndex(n => n.sessionId === sessionId);
      if (idx >= 0) {
        tree.nodes.splice(idx, 1);
        if (tree.nodes.length <= 1) delete data.trees[rootId];
        else data.trees[rootId] = tree;
        this.write(data);
        return { removedRoot: false, removedIds: [sessionId] };
      }
    }
    return { removedRoot: false, removedIds: [] };
  }

  pruneMissingSessions(existingSessionIds) {
    const valid = existingSessionIds instanceof Set ? existingSessionIds : new Set(existingSessionIds || []);
    const data = this.read();
    let removedNodes = 0;
    let removedTrees = 0;
    for (const [rootId, tree] of Object.entries(data.trees)) {
      const before = (tree.nodes || []).length;
      const kept = (tree.nodes || []).filter(n => n?.sessionId && valid.has(n.sessionId));
      removedNodes += Math.max(0, before - kept.length);
      if (!valid.has(rootId) || kept.length <= 1) {
        delete data.trees[rootId];
        removedTrees++;
      } else {
        tree.nodes = kept;
        data.trees[rootId] = tree;
      }
    }
    if (removedNodes > 0 || removedTrees > 0) this.write(data);
    return { removedNodes, removedTrees };
  }

  getDescendantsOfRoot(rootSessionId) {
    const data = this.read();
    const tree = data.trees[rootSessionId];
    if (!tree) return [];
    return (tree.nodes || []).map(n => n.sessionId).filter(id => id && id !== rootSessionId);
  }

  getViewForSession(sessionId) {
    const found = this.findTreeBySession(sessionId);
    if (!found) return null;
    const { rootId, tree } = found;
    const nodes = tree.nodes || [];
    const current = nodes.find(n => n.sessionId === sessionId) || nodes[0];
    const currentIndex = nodes.findIndex(n => n.sessionId === sessionId);

    // 按分叉点构建当前会话可见的兄弟组（每组只对应当前会话中的一条分叉消息）
    const forkGroups = [];
    const byForkPoint = new Map();
    for (const n of nodes) {
      if (!n.parentSessionId || !nonNegInt(n.anchorSeq)) continue;
      const fpId = n.forkPointId || `fp::${n.parentSessionId}::${n.anchorSeq}`;
      let list = byForkPoint.get(fpId);
      if (!list) { list = []; byForkPoint.set(fpId, list); }
      list.push(n);
    }

    for (const [forkPointId, children] of byForkPoint.entries()) {
      const originNode = nodes.find(n => n.sessionId === children[0].parentSessionId) || nodes[0];
      const groupNodes = [originNode, ...children].filter((item, idx, arr) =>
        item && arr.findIndex(x => x.sessionId === item.sessionId) === idx
      );
      const pos = groupNodes.findIndex(n => n.sessionId === sessionId);
      if (pos < 0 || groupNodes.length <= 1) continue;

      const isOrigin = originNode && originNode.sessionId === sessionId;
      const selfNode = groupNodes[pos];
      forkGroups.push({
        forkPointId,
        targetSeq: isOrigin ? children[0].anchorSeq : (nonNegInt(selfNode.branchAnchorSeq) ? selfNode.branchAnchorSeq : null),
        targetMessageId: isOrigin ? (children[0].anchorMessageId || null) : (selfNode.branchMessageId || null),
        currentIndex: pos,
        total: groupNodes.length,
        prevSessionId: pos > 0 ? groupNodes[pos - 1].sessionId : null,
        nextSessionId: pos < groupNodes.length - 1 ? groupNodes[pos + 1].sessionId : null,
        nodes: groupNodes.map(n => ({
          sessionId: n.sessionId,
          title: n.title,
          promptPreview: n.promptPreview || ''
        }))
      });
    }

    return {
      rootSessionId: rootId,
      isRoot: sessionId === rootId,
      currentIndex: currentIndex >= 0 ? currentIndex : 0,
      totalBranches: nodes.length,
      currentNode: current,
      nodes,
      forkGroups
    };
  }
}

function findSessionDirOnDisk(sessionsRoot, sessionId) {
  if (!fs.existsSync(sessionsRoot)) return null;
  for (const ws of fs.readdirSync(sessionsRoot)) {
    const wsPath = path.join(sessionsRoot, ws);
    try {
      if (!fs.statSync(wsPath).isDirectory()) continue;
    } catch { continue; }
    const candidate = path.join(wsPath, sessionId);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return { workspaceDir: wsPath, sessionDir: candidate };
    }
  }
  return null;
}

function readSourceSessionHeaderRaw(sessionDir) {
  if (!sessionDir || !fs.existsSync(sessionDir)) return null;
  try {
    const file = fs.readdirSync(sessionDir).find(f => /^session(?:\.v\d+)?\.jsonl\.zstd$/.test(f));
    if (!file) return null;
    const text = zlib.zstdDecompressSync(fs.readFileSync(path.join(sessionDir, file))).toString('utf8');
    const firstLine = text.split('\n', 1)[0];
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine);
    return parsed?.type === 'session' ? parsed : null;
  } catch {
    return null;
  }
}

function collectMethods(obj) {
  if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return [];
  const names = new Set();
  let cur = obj;
  let depth = 0;
  while (cur && cur !== Object.prototype && depth < 4) {
    for (const k of Object.getOwnPropertyNames(cur)) {
      if (k === 'constructor' || k.startsWith('_')) continue;
      try {
        if (typeof obj[k] === 'function') names.add(k);
      } catch {}
    }
    cur = Object.getPrototypeOf(cur);
    depth++;
  }
  return [...names].sort();
}

export function dumpHostServiceDiagnostics(dataRoot, services = {}) {
  try {
    const out = { at: new Date().toISOString(), services: {} };
    for (const [k, svc] of Object.entries(services)) {
      if (!svc) {
        out.services[k] = null;
        continue;
      }
      const entry = { methods: collectMethods(svc) };
      if (k === 'workspaceRegistry' && svc.entities && typeof svc.entities.values === 'function') {
        const first = svc.entities.values().next().value;
        if (first) {
          entry.entityMethods = collectMethods(first);
          entry.entityKeys = Object.keys(first);
          entry.recordKeys = first.record ? Object.keys(first.record) : [];
        }
      }
      out.services[k] = entry;
    }
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'host-api-diag.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
    return out;
  } catch {
    return null;
  }
}

export function encodeMultiFrameZstd(headerLine, bodyEvents = [], { batchSize = 8, maxBatchBytes = 6144 } = {}) {
  const frames = [];
  // Frame 0 严格仅包含单行顶层 session header（~180B），匹配 DSH readZstdPrefix / readFirstZstdLine 协议
  frames.push(zlib.zstdCompressSync(Buffer.from(JSON.stringify(headerLine) + '\n', 'utf8')));

  let batch = [];
  let batchBytes = 0;
  const flushBatch = () => {
    if (!batch.length) return;
    frames.push(zlib.zstdCompressSync(Buffer.from(batch.join('\n') + '\n', 'utf8')));
    batch = [];
    batchBytes = 0;
  };
  for (const ev of bodyEvents) {
    const line = JSON.stringify(ev);
    const bytes = Buffer.byteLength(line, 'utf8') + 1;
    if (batch.length > 0 && (batch.length >= batchSize || batchBytes + bytes > maxBatchBytes)) {
      flushBatch();
    }
    batch.push(line);
    batchBytes += bytes;
    if (bytes >= maxBatchBytes) flushBatch();
  }
  flushBatch();
  return Buffer.concat(frames);
}

async function attachBranchToSameWorkspace(ctx, sourceSessionId, branchSessionId, { workspaceRegistry = null, cwd = '', headerLine = null } = {}) {
  const registry = workspaceRegistry || ctx?.get?.('workspaceRegistry') || ctx?.workspaceRegistry || null;
  if (!registry) {
    return { ok: false, reason: 'workspaceRegistry 服务不可用', attempts: [] };
  }
  const attempts = [];
  const tryCall = async (label, fn) => {
    try {
      await fn();
      attempts.push({ label, ok: true });
      return true;
    } catch (err) {
      attempts.push({ label, ok: false, error: err?.message || String(err) });
      return false;
    }
  };

  let matchedWsId = null;
  let matchedEntity = null;
  const entities = registry.entities;
  if (entities && typeof entities.entries === 'function') {
    for (const [wsId, entity] of entities.entries()) {
      const sids = entity?.record?.sessionIds;
      if (Array.isArray(sids) && sids.includes(sourceSessionId)) {
        matchedWsId = wsId;
        matchedEntity = entity;
        break;
      }
    }
    if (!matchedEntity && cwd) {
      const normCwd = path.resolve(cwd).toLowerCase();
      for (const [wsId, entity] of entities.entries()) {
        const ep = entity?.record?.path || entity?.record?.cwd;
        if (ep && path.resolve(ep).toLowerCase() === normCwd) {
          matchedWsId = wsId;
          matchedEntity = entity;
          break;
        }
      }
    }
  }

  // 先将新分支头信息同步进 workspaceRegistry 头索引（避免 attachSession 校验时读到旧缓存）
  if (typeof registry.readSessionHeader === 'function') {
    await tryCall('registry.readSessionHeader', () => registry.readSessionHeader(branchSessionId));
  }
  if (headerLine && typeof registry.indexHeader === 'function') {
    await tryCall('registry.indexHeader', () => registry.indexHeader(headerLine));
  }

  const verifyAttached = () => {
    if (matchedEntity && Array.isArray(matchedEntity.record?.sessionIds)) {
      return matchedEntity.record.sessionIds.includes(branchSessionId);
    }
    return false;
  };

  if (matchedEntity) {
    for (const method of ['attachSession', 'addSession', 'appendSession', 'bindSession', 'registerSession']) {
      if (typeof matchedEntity[method] === 'function') {
        const ok = await tryCall(`entity.${method}`, () => matchedEntity[method](branchSessionId));
        if (ok && verifyAttached()) {
          return { ok: true, method: `entity.${method}`, workspaceId: matchedWsId, attempts };
        }
      }
    }
  }

  if (matchedWsId) {
    for (const method of ['attachSession', 'addSession', 'bindSession', 'registerSession']) {
      if (typeof registry[method] === 'function') {
        const ok = await tryCall(`registry.${method}(wsId, sid)`, () => registry[method](matchedWsId, branchSessionId));
        if (ok && verifyAttached()) {
          return { ok: true, method: `registry.${method}`, workspaceId: matchedWsId, attempts };
        }
      }
    }
  }

  if (verifyAttached()) {
    return { ok: true, method: 'verified', workspaceId: matchedWsId, attempts };
  }

  const lastErr = [...attempts].reverse().find(a => !a.ok)?.error || '';
  return {
    ok: false,
    workspaceId: matchedWsId,
    reason: matchedEntity
      ? `未能将分支挂入工作区${lastErr ? `（${lastErr}）` : ''}`
      : `未在 workspaceRegistry 中找到原会话 ${sourceSessionId} 所属工作区`,
    attempts
  };
}

export async function createPhysicalBranchSession({
  ctx,
  dshHome,
  sourceSession,
  sourceSessionId,
  anchorSeq,
  branchTitle,
  workspaceRegistry = null,
  sessionPersistence = null,
  sessions = null
}) {
  const events = sourceSession?.snapshotEvents?.() ?? [];
  const header = sourceSession?.header || {};
  const sessionsRoot = path.join(dshHome, 'sessions');
  const found = findSessionDirOnDisk(sessionsRoot, sourceSessionId);
  const rawDiskHeader = readSourceSessionHeaderRaw(found?.sessionDir);

  const formatVersion = Number.isSafeInteger(rawDiskHeader?.version)
    ? rawDiskHeader.version
    : (Number.isSafeInteger(header.version) ? header.version : 4);
  const branchSessionId = 'session-' + crypto.randomUUID();
  const prefixEvents = sliceCleanPrefixEvents(events, anchorSeq);
  const nowMs = Date.now();
  const resolvedCwd = rawDiskHeader?.cwd || header.cwd || process.cwd();

  // 严格匹配 DSH Session v3/v4 原生顶层 header 格式（无 seq / data 嵌套），首条业务事件从 seq: 0 编号
  const headerLine = {
    type: 'session',
    version: formatVersion,
    id: branchSessionId,
    createdAt: nowMs,
    cwd: resolvedCwd,
    isSeeded: false,
    delegationDepth: 0,
    ...(rawDiskHeader?.agentPreset || header.agentPreset
      ? { agentPreset: rawDiskHeader?.agentPreset || header.agentPreset }
      : {})
  };

  const bodyEvents = [];
  let nextSeq = 0;
  for (const ev of prefixEvents) {
    let cloned = { ...ev, seq: nextSeq++ };
    if (
      typeof ev.type === 'string'
      && ev.type.startsWith('plugin:cabinet-v2/')
      && ev.data
      && typeof ev.data === 'object'
      && ev.data.sessionId === sourceSessionId
    ) {
      cloned = { ...cloned, data: { ...ev.data, sessionId: branchSessionId } };
    }
    bodyEvents.push(cloned);
  }
  // 严格匹配 DSH v4 用户标题事件协议：必须包含 messageSeqs 数组与 source
  bodyEvents.push({
    type: 'session/title',
    seq: nextSeq++,
    time: nowMs,
    data: {
      title: branchTitle,
      messageSeqs: [],
      source: { kind: 'user' }
    }
  });

  const persistence = sessionPersistence || ctx?.get?.('sessionPersistence') || ctx?.sessionPersistence || null;
  let branchDir;
  let targetFilePath;
  if (found?.workspaceDir) {
    branchDir = path.join(found.workspaceDir, branchSessionId);
    const fileName = formatVersion >= 4 ? `session.v${formatVersion}.jsonl.zstd` : 'session.jsonl.zstd';
    targetFilePath = path.join(branchDir, fileName);
  } else {
    let located = null;
    if (typeof persistence?.locate === 'function') {
      try {
        const loc = persistence.locate(headerLine) || persistence.locate({ id: branchSessionId, cwd: resolvedCwd });
        const candidate = typeof loc === 'string' ? loc : (loc?.currentPath || loc?.path || null);
        if (candidate && typeof candidate === 'string' && candidate.includes(branchSessionId) && /\.jsonl(?:\.zstd)?$/.test(candidate)) {
          located = candidate;
        }
      } catch {}
    }
    if (located) {
      targetFilePath = located;
      branchDir = path.dirname(located);
    } else {
      const targetWorkspaceDir = path.join(sessionsRoot, '--E-DSH-home-clean-documents-deepseek-harness-default-workspace--');
      branchDir = path.join(targetWorkspaceDir, branchSessionId);
      const fileName = formatVersion >= 4 ? `session.v${formatVersion}.jsonl.zstd` : 'session.jsonl.zstd';
      targetFilePath = path.join(branchDir, fileName);
    }
  }
  fs.mkdirSync(branchDir, { recursive: true });

  // 按 DSH 原生多帧 Zstd 格式写入：Frame 0 单独压缩 headerLine，后续按小批次分帧
  const compressed = encodeMultiFrameZstd(headerLine, bodyEvents);
  fs.writeFileSync(targetFilePath, compressed);

  // 主动刷新 sessionPersistence 索引并核验宿主是否已识别该多帧日志
  const persistenceCheck = { targetFilePath, exists: null, findLog: null, listRefreshed: false };
  if (persistence) {
    try {
      if (typeof persistence.mapSessionDirectories === 'function') await persistence.mapSessionDirectories();
    } catch {}
    try {
      if (typeof persistence.list === 'function') {
        await persistence.list();
        persistenceCheck.listRefreshed = true;
      }
    } catch {}
    try {
      if (typeof persistence.exists === 'function') {
        persistenceCheck.exists = Boolean(await persistence.exists(branchSessionId));
      }
    } catch (e) { persistenceCheck.existsErr = e?.message || String(e); }
    try {
      if (typeof persistence.findLog === 'function') {
        const fl = await persistence.findLog(branchSessionId);
        persistenceCheck.findLog = typeof fl === 'string' ? fl : (fl?.currentPath || fl?.sourcePath || Boolean(fl));
      }
    } catch (e) { persistenceCheck.findLogErr = e?.message || String(e); }
  }

  const attachResult = await attachBranchToSameWorkspace(ctx, sourceSessionId, branchSessionId, {
    workspaceRegistry,
    cwd: resolvedCwd,
    headerLine
  });

  // 预热 sessions 内存注册表（DSH 0.2.x sessions 使用 prepare）
  const sessSvc = sessions || ctx?.get?.('sessions') || ctx?.sessions || null;
  if (attachResult.ok && typeof sessSvc?.prepare === 'function') {
    try { await sessSvc.prepare(branchSessionId); } catch {}
  }

  return {
    branchSessionId,
    branchDir,
    targetFilePath,
    prefixEventCount: prefixEvents.length,
    bodyEventCount: bodyEvents.length,
    persistenceCheck,
    attachResult
  };
}

export function installBranchCascadeHooks(ctx, branchStore, onCascadeDeleteExtra = null) {
  if (!ctx) return () => {};
  const disposers = [];
  let cascading = false;

  const patchRegistry = (registry) => {
    if (!registry || registry[CABINET_BRANCH_PATCH]) return;
    registry[CABINET_BRANCH_PATCH] = true;

    const origArchive = typeof registry.archiveSession === 'function' ? registry.archiveSession.bind(registry) : null;
    if (origArchive) {
      registry.archiveSession = async function cabinetCascadeArchive(sessionId, options) {
        const res = await origArchive(sessionId, options);
        if (!cascading) {
          const descendants = branchStore.getDescendantsOfRoot(sessionId);
          if (descendants.length) {
            cascading = true;
            try {
              for (const childId of descendants) {
                await origArchive(childId, options).catch(() => {});
              }
            } finally { cascading = false; }
          }
        }
        return res;
      };
      disposers.push(() => { if (registry.archiveSession) registry.archiveSession = origArchive; });
    }

    const origUnarchive = typeof registry.unarchiveSession === 'function' ? registry.unarchiveSession.bind(registry) : null;
    if (origUnarchive) {
      registry.unarchiveSession = async function cabinetCascadeUnarchive(sessionId) {
        const res = await origUnarchive(sessionId);
        if (!cascading) {
          const descendants = branchStore.getDescendantsOfRoot(sessionId);
          if (descendants.length) {
            cascading = true;
            try {
              for (const childId of descendants) {
                await origUnarchive(childId).catch(() => {});
              }
            } finally { cascading = false; }
          }
        }
        return res;
      };
      disposers.push(() => { if (registry.unarchiveSession) registry.unarchiveSession = origUnarchive; });
    }

    const origDelete = typeof registry.permanentlyDeleteSession === 'function' ? registry.permanentlyDeleteSession.bind(registry) : null;
    if (origDelete) {
      registry.permanentlyDeleteSession = async function cabinetCascadeDelete(sessionId, options) {
        if (!cascading) {
          const descendants = branchStore.getDescendantsOfRoot(sessionId);
          if (descendants.length) {
            cascading = true;
            try {
              for (const childId of descendants) {
                await origDelete(childId, options).catch(() => {});
                if (typeof onCascadeDeleteExtra === 'function') await onCascadeDeleteExtra(childId);
              }
            } finally { cascading = false; }
          }
          branchStore.removeBranchNode(sessionId);
        }
        const res = await origDelete(sessionId, options);
        if (typeof onCascadeDeleteExtra === 'function') await onCascadeDeleteExtra(sessionId);
        return res;
      };
      disposers.push(() => { if (registry.permanentlyDeleteSession) registry.permanentlyDeleteSession = origDelete; });
    }
  };

  const directReg = ctx?.get?.('workspaceRegistry') ?? ctx?.workspaceRegistry;
  if (directReg) patchRegistry(directReg);
  else if (typeof ctx?.inject === 'function') {
    try { ctx.inject(['workspaceRegistry'], scoped => patchRegistry(scoped?.get?.('workspaceRegistry') ?? scoped?.workspaceRegistry)); } catch {}
  }

  return () => {
    while (disposers.length) { try { disposers.pop()(); } catch {} }
  };
}
