import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export function appendPluginRecord(session, type, data) {
  if (!session) return;
  if (typeof session.append === 'function') {
    session.append(type, data);
  } else if (typeof session.appendEvent === 'function') {
    session.appendEvent({ type, data });
  }
}

const execFileAsync = promisify(execFile);
export const NS = 'plugin:cabinet-v2/';

export const READONLY_TOOLS = Object.freeze([
  {
    name: 'list_files',
    description: '列出工作区指定相对路径下的文件与子目录',
    parameters: { type: 'object', properties: { dir: { type: 'string' } }, additionalProperties: false }
  },
  {
    name: 'read_file',
    description: '读取工作区内的文本文件内容',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }
  },
  {
    name: 'search_text',
    description: '在工作区文本文件中搜索关键字',
    parameters: { type: 'object', properties: { query: { type: 'string' }, dir: { type: 'string' } }, required: ['query'], additionalProperties: false }
  }
]);

export const WRITE_TOOLS = Object.freeze([
  ...READONLY_TOOLS,
  {
    name: 'write_file',
    description: '在工作区内创建或写入文本文件（施工阶段使用）',
    parameters: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' } }, required: ['path', 'text'], additionalProperties: false }
  },
  {
    name: 'edit_file',
    description: '替换工作区文件中的指定文本片段（施工阶段使用）',
    parameters: { type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } }, required: ['path', 'oldText', 'newText'], additionalProperties: false }
  },
  {
    name: 'run_command',
    description: '在工作区执行非交互式验证命令（施工阶段使用）',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false }
  }
]);

export function resolveWorkspacePath(workspaceRoot, targetPath) {
  const root = path.resolve(workspaceRoot || process.cwd());
  const raw = String(targetPath || '.').trim();
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`路径超出当前工作区范围：${raw}`);
  }
  return { root, resolved, relative: rel || '.' };
}

export class SessionManager {
  constructor(ctx, dataRoot) {
    this.ctx = ctx;
    this.dataRoot = path.resolve(dataRoot);
    this.groupStoreDir = path.join(this.dataRoot, 'groups');
    this.originalStoreDir = path.join(this.dataRoot, 'originals');
    fs.mkdirSync(this.groupStoreDir, { recursive: true });
    fs.mkdirSync(this.originalStoreDir, { recursive: true });
  }

  toolsForRole(role, { allowWrite = false, agent = null } = {}) {
    const canWrite = (role === 'construction' || role === 'secretary') && allowWrite;
    const baseTools = canWrite ? WRITE_TOOLS : READONLY_TOOLS;
    let hostToolsSvc = null;
    try { hostToolsSvc = this.ctx?.get?.('tools') ?? this.ctx?.tools; } catch { try { hostToolsSvc = this.ctx?.get?.('tools'); } catch {} }
    if (!hostToolsSvc?.view) return baseTools;
    try {
      const view = hostToolsSvc.view(agent);
      const hostDefs = [...(view?.visible?.values?.() ?? [])].filter(def => {
        if (!def?.name || baseTools.some(b => b.name === def.name)) return false;
        if (!canWrite && /write|edit|delete|remove|bash|exec|run|powershell|click|type|key/i.test(def.name)) return false;
        return true;
      });
      return [...baseTools, ...hostDefs];
    } catch {
      return baseTools;
    }
  }

  async executeToolCall(toolCall, { workspaceRoot, role, allowWrite = false, agent = null, signal }) {
    const name = toolCall?.name;
    const args = toolCall?.arguments ?? {};
    const writeOps = new Set(['write_file', 'edit_file', 'run_command']);
    if (writeOps.has(name) && !allowWrite) {
      throw new Error(`当前角色（${role}）处于只读模式，不能执行修改操作：${name}`);
    }

    if (name === 'list_files') {
      const { resolved, relative } = resolveWorkspacePath(workspaceRoot, args.dir || '.');
      const entries = await fsp.readdir(resolved, { withFileTypes: true });
      const items = entries
        .filter(e => !['node_modules', '.git'].includes(e.name))
        .slice(0, 120)
        .map(e => `${e.isDirectory() ? '[DIR] ' : ''}${e.name}`);
      return { tool: name, path: relative, summary: `共 ${items.length} 项`, output: items.join('\n') };
    }

    if (name === 'read_file') {
      const { resolved, relative } = resolveWorkspacePath(workspaceRoot, args.path);
      const text = await fsp.readFile(resolved, 'utf8');
      return { tool: name, path: relative, bytes: Buffer.byteLength(text, 'utf8'), summary: `读取 ${relative}`, output: text };
    }

    if (name === 'search_text') {
      const { resolved, relative } = resolveWorkspacePath(workspaceRoot, args.dir || '.');
      const query = String(args.query || '').trim();
      const hits = [];
      const walk = async dir => {
        if (hits.length >= 40) return;
        const list = await fsp.readdir(dir, { withFileTypes: true });
        for (const item of list) {
          if (['node_modules', '.git', 'dist', 'backups'].includes(item.name)) continue;
          const full = path.join(dir, item.name);
          if (item.isDirectory()) await walk(full);
          else if (item.isFile()) {
            try {
              const stat = await fsp.stat(full);
              if (stat.size > 512000) continue;
              const content = await fsp.readFile(full, 'utf8');
              const lines = content.split(/\r?\n/);
              lines.forEach((line, idx) => {
                if (hits.length < 40 && line.includes(query)) {
                  hits.push(`${path.relative(resolved, full)}:${idx + 1}: ${line.slice(0, 160)}`);
                }
              });
            } catch {}
          }
        }
      };
      if (query) await walk(resolved);
      return { tool: name, path: relative, summary: `匹配 ${hits.length} 处`, output: hits.join('\n') || '未找到匹配项' };
    }

    if (name === 'write_file') {
      const { resolved, relative } = resolveWorkspacePath(workspaceRoot, args.path);
      await fsp.mkdir(path.dirname(resolved), { recursive: true });
      const text = String(args.text ?? '');
      await fsp.writeFile(resolved, text, 'utf8');
      const verify = await fsp.readFile(resolved, 'utf8');
      return { tool: name, path: relative, fullPath: resolved, bytes: Buffer.byteLength(verify, 'utf8'), summary: `已写入 ${relative}（${Buffer.byteLength(verify, 'utf8')} B）`, output: verify };
    }

    if (name === 'edit_file') {
      const { resolved, relative } = resolveWorkspacePath(workspaceRoot, args.path);
      const current = await fsp.readFile(resolved, 'utf8');
      const oldText = String(args.oldText ?? '');
      const newText = String(args.newText ?? '');
      if (!oldText || !current.includes(oldText)) {
        throw new Error(`未在 ${relative} 中找到待替换的目标文本片段`);
      }
      const updated = current.replace(oldText, newText);
      await fsp.writeFile(resolved, updated, 'utf8');
      return { tool: name, path: relative, fullPath: resolved, bytes: Buffer.byteLength(updated, 'utf8'), summary: `已更新 ${relative}`, output: updated };
    }

    if (name === 'run_command') {
      const { root } = resolveWorkspacePath(workspaceRoot, '.');
      const { stdout, stderr } = await execFileAsync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', String(args.command || '')], {
        cwd: root,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        signal
      });
      const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
      return { tool: name, path: '.', summary: '命令执行完成', output: combined.slice(0, 8000) };
    }

    let hostToolsSvc = null;
    try { hostToolsSvc = this.ctx?.get?.('tools') ?? this.ctx?.tools; } catch { try { hostToolsSvc = this.ctx?.get?.('tools'); } catch {} }
    if (hostToolsSvc?.execute) {
      const batch = await hostToolsSvc.execute({
        calls: [{ type: 'tool-call', id: toolCall.id || 'tc-1', name, input: args }],
        signal,
        ...(agent ? { agent } : {})
      });
      const firstOut = batch?.outputs?.[0] ?? batch?.results?.[0] ?? batch;
      return {
        tool: name,
        path: args.path || '',
        summary: `已执行 ${name}`,
        output: typeof firstOut === 'string' ? firstOut : JSON.stringify(firstOut, null, 2)
      };
    }

    throw new Error(`未知工具：${name}`);
  }

  saveOriginal(sessionId, payload) {
    const sourceId = payload.sourceId || `orig-${crypto.randomUUID()}`;
    const record = {
      sourceId,
      sessionId,
      createdAt: new Date().toISOString(),
      ...payload
    };
    const file = path.join(this.originalStoreDir, `${sourceId}.json`);
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf8');
    return record;
  }

  readOriginal(sourceId) {
    const safeId = String(sourceId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const file = path.join(this.originalStoreDir, `${safeId}.json`);
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  groupFile(sessionId, groupKey) {
    const hash = crypto.createHash('sha256').update(`${sessionId}::${groupKey}`).digest('hex').slice(0, 24);
    return path.join(this.groupStoreDir, `group-${hash}.json`);
  }

  readGroupThread(sessionId, groupKey, groupLabel = '工作组') {
    const file = this.groupFile(sessionId, groupKey);
    if (!fs.existsSync(file)) {
      return { sessionId, groupKey, label: groupLabel, currentRound: 1, rounds: [{ round: 1, title: '第 1 轮', messages: [] }] };
    }
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return { sessionId, groupKey, label: groupLabel, currentRound: 1, rounds: [{ round: 1, title: '第 1 轮', messages: [] }] };
    }
  }

  appendGroupMessage(sessionId, groupKey, groupLabel, roundNumber, message) {
    const thread = this.readGroupThread(sessionId, groupKey, groupLabel);
    thread.label = groupLabel || thread.label;
    thread.currentRound = Math.max(thread.currentRound || 1, roundNumber || 1);
    let roundObj = thread.rounds.find(r => r.round === roundNumber);
    if (!roundObj) {
      roundObj = { round: roundNumber, title: `第 ${roundNumber} 轮`, subtitle: message.stageTitle || '', messages: [] };
      thread.rounds.push(roundObj);
    }
    if (message.stageTitle && !roundObj.subtitle) roundObj.subtitle = message.stageTitle;
    const entry = {
      id: message.id || `msg-${crypto.randomUUID()}`,
      at: new Date().toISOString(),
      round: roundNumber,
      actorId: message.actorId,
      actorLabel: message.actorLabel,
      roleLabel: message.roleLabel,
      providerId: message.providerId,
      modelId: message.modelId,
      text: String(message.text ?? ''),
      toolRecords: Array.isArray(message.toolRecords) ? message.toolRecords : [],
      sourceId: message.sourceId || null
    };
    roundObj.messages.push(entry);
    fs.writeFileSync(this.groupFile(sessionId, groupKey), JSON.stringify(thread, null, 2) + '\n', 'utf8');
    return entry;
  }

  appendMainAssistantMessage(parentAgent, { title, role, participantId, providerId, modelId, phase, groupKey = null, formalVersion = null, text, sourceId = null }) {
    const messageId = `cab-msg-${crypto.randomUUID()}`;
    const bodyText = String(text ?? '').trim();
    if (parentAgent?.session?.append && bodyText) {
      const turn = (parentAgent.session.snapshotEvents?.().filter(e => e.type === 'turn/start').length || 0) + 1;
      try {
        parentAgent.session.append('assistant/message', {
          turn,
          step: 0,
          message: {
            id: messageId,
            role: 'assistant',
            source: { kind: 'model', provider: providerId || 'cabinet', model: modelId || 'cabinet' },
            content: [{ type: 'text', text: bodyText }]
          }
        }, { surfaceOp: 'append' });
      } catch {}
      try {
        appendPluginRecord(parentAgent.session, NS + 'presentation', {
          messageId,
          sourceId: sourceId || messageId,
          sessionId: parentAgent.id,
          title,
          role,
          participantId,
          provider: providerId,
          model: modelId,
          phase,
          groupKey,
          formalVersion,
          at: new Date().toISOString()
        });
      } catch {}
    }
    return messageId;
  }
}
