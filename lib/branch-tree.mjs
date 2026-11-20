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

export function listForkableUserMessages(events = []) {
  const out = [];
  for (const ev of events) {
    if (!ev || !nonNegInt(ev.seq)) continue;
    if (ev.type === 'user/message') {
      const kind = ev.data?.source?.kind;
      if (kind && kind !== 'user') continue;
      const text = extractUserPromptText(ev);
      if (!text) continue;
      out.push({ seq: ev.seq, type: ev.type, text, time: ev.time || null, mode: 'ordinary' });
    } else if (ev.type === 'plugin:cabinet-v2/user-prompt') {
      const text = extractUserPromptText(ev);
      if (!text) continue;
      out.push({ seq: ev.seq, type: ev.type, text, time: ev.time || null, mode: 'cabinet' });
    }
  }
  return out.reverse();
}

export function sliceCleanPrefixEvents(events = [], anchorSeq) {
  const clean = [];
  for (const ev of events) {
    if (!ev || !nonNegInt(ev.seq)) continue;
    if (ev.seq >= anchorSeq) break;
    if (ev.type === 'session') continue;
    clean.push(ev);
  }
  return clean;
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

  recordBranch({ sourceSessionId, branchSessionId, anchorSeq, promptText, title, mode = 'ordinary' }) {
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
          title: '原主对话',
          promptPreview: '',
          mode,
          createdAt: now
        }]
      };
    }
    const clean = String(promptText || '').replace(/\s+/g, ' ').trim();
    const chars = Array.from(clean);
    const preview = chars.slice(0, 20).join('') + (chars.length > 20 ? '…' : '');
    tree.nodes.push({
      sessionId: branchSessionId,
      parentSessionId: sourceSessionId,
      anchorSeq,
      title: title || `分支 ${tree.nodes.length}`,
      promptPreview: preview,
      mode,
      createdAt: now
    });
    data.trees[rootId] = tree;
    this.write(data);
    return tree;
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
    return {
      rootSessionId: rootId,
      isRoot: sessionId === rootId,
      currentIndex: currentIndex >= 0 ? currentIndex : 0,
      totalBranches: nodes.length,
      currentNode: current,
      nodes
    };
  }
}


function findSessionDirOnDisk(sessionsRoot, sessionId) {
  if (!fs.existsSync(sessionsRoot)) return null;
  for (const ws of fs.readdirSync(sessionsRoot)) {
    const candidate = path.join(sessionsRoot, ws, sessionId);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return { workspaceDir: path.join(sessionsRoot, ws), sessionDir: candidate };
    }
  }
  return null;
}

export async function createPhysicalBranchSession({
  ctx,
  dshHome,
  sourceSession,
  sourceSessionId,
  anchorSeq,
  branchTitle
}) {
  const events = sourceSession?.snapshotEvents?.() ?? [];
  const header = sourceSession?.header || {};
  const formatVersion = Number.isSafeInteger(header.version) ? header.version : 4;
  const branchSessionId = 'session-' + crypto.randomUUID();
  const prefixEvents = sliceCleanPrefixEvents(events, anchorSeq);
  const nowMs = Date.now();

  const headerEvent = {
    seq: 0,
    type: 'session',
    time: nowMs,
    data: {
      id: branchSessionId,
      version: formatVersion,
      cwd: header.cwd || process.cwd(),
      origin: 'main',
      createdAt: nowMs
    }
  };

  const renumbered = [headerEvent];
  let nextSeq = 1;
  for (const ev of prefixEvents) {
    renumbered.push({ ...ev, seq: nextSeq++ });
  }
  renumbered.push({
    seq: nextSeq++,
    type: 'session/title',
    time: nowMs,
    data: { title: branchTitle }
  });

  const sessionsRoot = path.join(dshHome, 'sessions');
  const found = findSessionDirOnDisk(sessionsRoot, sourceSessionId);
  const targetWorkspaceDir = found?.workspaceDir
    || path.join(sessionsRoot, '--E-DSH-home-clean-documents-deepseek-harness-default-workspace--');
  const branchDir = path.join(targetWorkspaceDir, branchSessionId);
  fs.mkdirSync(branchDir, { recursive: true });

  const jsonl = renumbered.map(item => JSON.stringify(item)).join('\n') + '\n';
  const compressed = zlib.zstdCompressSync(Buffer.from(jsonl, 'utf8'));
  const fileName = formatVersion >= 4 ? `session.v${formatVersion}.jsonl.zstd` : 'session.jsonl.zstd';
  fs.writeFileSync(path.join(branchDir, fileName), compressed);

  const registry = ctx?.get?.('workspaceRegistry') ?? ctx?.workspaceRegistry;
  if (registry) {
    try {
      if (typeof registry.addSession === 'function') {
        await registry.addSession(sourceSessionId, branchSessionId);
      } else if (typeof registry.requireState === 'function' && typeof registry.setState === 'function') {
        const state = registry.requireState();
        const workspaces = state?.workspaces || {};
        for (const ws of Object.values(workspaces)) {
          if (Array.isArray(ws?.sessionIds) && ws.sessionIds.includes(sourceSessionId)) {
            if (!ws.sessionIds.includes(branchSessionId)) {
              ws.sessionIds = [...ws.sessionIds, branchSessionId];
              ws.updatedAt = new Date().toISOString();
            }
            break;
          }
        }
        await registry.setState(state);
      }
    } catch {}
  }

  return { branchSessionId, branchDir, prefixEventCount: prefixEvents.length };
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

