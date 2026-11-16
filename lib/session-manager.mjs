import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MAIN_CONTEXT_TOOL } from './main-context.mjs';

let nativeSessionApi;
const groupOperations = new Map();

async function officialRecordAppend() {
  nativeSessionApi ??= import('@deepseek-ai/dsh-session');
  return (await nativeSessionApi).appendPluginRecord;
}

export async function appendPluginRecord(session, type, data, nativeAppend) {
  if (!session) throw new Error('原生会话不可用');
  const append = nativeAppend ?? await officialRecordAppend();
  return append(session, type, JSON.parse(JSON.stringify(data)));
}

function groupError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function writeJson(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) {
      try { fs.unlinkSync(temporary); } catch {}
    }
  }
}

function serializeGroup(key, operation) {
  const prior = groupOperations.get(key) ?? Promise.resolve();
  const running = prior.catch(() => {}).then(operation);
  groupOperations.set(key, running);
  void running.finally(() => { if (groupOperations.get(key) === running) groupOperations.delete(key); }).catch(() => {});
  return running;
}

function mergeInstructionQueue(prior = [], incoming = []) {
  const merged = new Map(prior.map(item => [item.id, structuredClone(item)]));
  for (const candidate of incoming) {
    const existing = merged.get(candidate.id);
    if (!existing) { merged.set(candidate.id, structuredClone(candidate)); continue; }
    const entry = { ...existing, ...structuredClone(candidate) };
    if (existing.groupKey && !candidate.groupKey) entry.groupKey = existing.groupKey;
    if (existing.status === 'delivered') {
      entry.status = 'delivered';
      entry.deliveredAt = existing.deliveredAt ?? candidate.deliveredAt;
    }
    merged.set(candidate.id, entry);
  }
  return [...merged.values()];
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
    description: '在工作区通过 Windows PowerShell (pwsh.exe) 执行非交互式验证命令（施工阶段使用，请使用 PowerShell 语法）',
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
  constructor(ctx, dataRoot, options = {}) {
    this.ctx = ctx;
    this.dataRoot = path.resolve(dataRoot);
    this.groupStoreDir = path.join(this.dataRoot, 'groups');
    this.originalStoreDir = path.join(this.dataRoot, 'originals');
    this.groupBindingsDir = path.join(this.dataRoot, 'group-bindings');
    this.nativeAppend = options.nativeAppend;
    this.onGroupConversation = options.onGroupConversation;
    this.childBindings = new Map();
    this.manualSpeechClaims = new WeakMap();
    fs.mkdirSync(this.groupStoreDir, { recursive: true });
    fs.mkdirSync(this.originalStoreDir, { recursive: true });
    fs.mkdirSync(this.groupBindingsDir, { recursive: true });
    for (const name of fs.readdirSync(this.groupBindingsDir).filter(name => /^binding-[a-f0-9]+\.json$/.test(name))) {
      const binding = JSON.parse(fs.readFileSync(path.join(this.groupBindingsDir, name), 'utf8'));
      if (binding.childSessionId && binding.state === 'ready') this.childBindings.set(binding.childSessionId, binding);
    }
  }

  toolsForRole(role, { allowWrite = false, agent = null, mainContext = null, mainReadScope = null } = {}) {
    const canWrite = (role === 'construction' || role === 'secretary') && allowWrite;
    const baseTools = [...(canWrite ? WRITE_TOOLS : READONLY_TOOLS),
      ...(mainContext?.canRead(mainReadScope) ? [MAIN_CONTEXT_TOOL] : [])];
    let hostToolsSvc = null;
    try { hostToolsSvc = this.ctx?.get?.('tools') ?? this.ctx?.tools; } catch { try { hostToolsSvc = this.ctx?.get?.('tools'); } catch {} }
    if (!hostToolsSvc?.schemas && !hostToolsSvc?.view) return baseTools;
    try {
      const schemas = hostToolsSvc.schemas ? hostToolsSvc.schemas(agent ?? undefined)
        : [...(hostToolsSvc.view(agent)?.visible?.values?.() ?? [])];
      const hostDefs = schemas.filter(def => {
        // This name belongs to the task-bound reader, never a host fallback.
        if (def?.name === MAIN_CONTEXT_TOOL.name) return false;
        if (!def?.name || baseTools.some(b => b.name === def.name)) return false;
        if (!canWrite && /write|edit|delete|remove|create|update|insert|append|save|bash|exec|run|powershell|click|type|key/i.test(def.name)) return false;
        return true;
      });
      return [...baseTools, ...hostDefs];
    } catch {
      return baseTools;
    }
  }

  async executeToolCall(toolCall, { workspaceRoot, role, allowWrite = false, agent = null, signal, mainContext = null, mainReadScope = null, allowedTools = null }) {
    const name = toolCall?.name;
    const args = toolCall?.arguments ?? {};
    if (name === MAIN_CONTEXT_TOOL.name) {
      if (!mainContext?.canRead(mainReadScope)) throw groupError('MAIN_CONTEXT_FORBIDDEN', '当前席位无主对话读取权限');
      if (allowedTools && !allowedTools.has(name)) throw groupError('TOOL_NOT_GRANTED', '本次调用未获该工具权限');
      return mainContext.read(mainReadScope, args);
    }
    if (allowedTools && !allowedTools.has(name)) throw groupError('TOOL_NOT_GRANTED', '本次调用未获该工具权限');
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
      try {
        const { stdout, stderr } = await execFileAsync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', String(args.command || '')], {
          cwd: root,
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          signal
        });
        const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
        return { tool: name, path: '.', summary: '命令执行完成', output: combined.slice(0, 8000) };
      } catch (err) {
        if (err?.name === 'AbortError' || signal?.aborted) throw err;
        const combined = [err?.stdout, err?.stderr, err?.message].filter(Boolean).join('\n').trim();
        return { tool: name, path: '.', isError: true, summary: '命令执行失败', output: combined.slice(0, 8000) || '命令执行失败' };
      }
    }

    let hostToolsSvc = null;
    try { hostToolsSvc = this.ctx?.get?.('tools') ?? this.ctx?.tools; } catch { try { hostToolsSvc = this.ctx?.get?.('tools'); } catch {} }
    if (hostToolsSvc?.execute) {
      const callId = toolCall.id || 'tc-1';
      const batch = await hostToolsSvc.execute({
        calls: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }],
        signal,
        ...(agent ? { agent } : {})
      });
      const matches = batch?.results?.filter(item => item.callId === callId);
      const result = matches?.length === 1 ? matches[0].result : null;
      if (!result || typeof result.isError !== 'boolean' || !Array.isArray(result.content)) {
        throw groupError('CABINET_INVALID_TOOL_RESULT', '宿主工具没有返回与调用 ID 对应的有效结果');
      }
      const content = structuredClone(result.content);
      const output = content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      return {
        tool: name,
        path: args.path || '',
        summary: result.isError ? result.error?.message || `工具 ${name} 返回错误` : `已执行 ${name}`,
        isError: result.isError,
        ...(result.error ? { error: structuredClone(result.error) } : {}),
        content,
        output: output || JSON.stringify(content)
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
    writeJson(file, record);
    return record;
  }

  readOriginal(sourceId) {
    const safeId = String(sourceId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const file = path.join(this.originalStoreDir, `${safeId}.json`);
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  groupFile(sessionId, groupKey, taskId) {
    const identity = taskId ? JSON.stringify([sessionId, taskId, groupKey]) : `${sessionId}::${groupKey}`;
    const hash = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24);
    return path.join(this.groupStoreDir, `group-${hash}.json`);
  }

  readGroupThread(sessionId, groupKey, groupLabel = '工作组', taskId) {
    const file = this.groupFile(sessionId, groupKey, taskId);
    const thread = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    if (!thread) return { sessionId, groupKey, ...(taskId ? { taskId } : {}), label: groupLabel, currentRound: 1, rounds: [{ round: 1, title: '第 1 轮', messages: [] }] };
    if (thread.sessionId !== sessionId || thread.groupKey !== groupKey || (taskId && thread.taskId !== taskId)) throw groupError('GROUP_THREAD_IDENTITY', '组聊归属不一致，已停止写入');
    return thread;
  }

  readGroupOriginals(sessionId, groupKey, taskId) {
    return fs.readdirSync(this.originalStoreDir).filter(name => /^[a-zA-Z0-9_-]+\.json$/.test(name))
      .flatMap(name => {
        try { return [JSON.parse(fs.readFileSync(path.join(this.originalStoreDir, name), 'utf8'))]; }
        catch (error) { if (error instanceof SyntaxError || error.code === 'ENOENT') return []; throw error; }
      })
      .filter(entry => entry?.sessionId === sessionId && entry.taskId === taskId && entry.groupKey === groupKey);
  }

  mutateGroupThread(sessionId, groupKey, taskId, operation) {
    const file = this.groupFile(sessionId, groupKey, taskId);
    const thread = this.readGroupThread(sessionId, groupKey, '工作组', taskId);
    const result = operation(thread);
    if (result?.then) throw new TypeError('Group record mutations must be synchronous');
    writeJson(file, thread);
    return result;
  }

  appendGroupMessage(sessionId, groupKey, groupLabel, roundNumber, message) {
    return this.mutateGroupThread(sessionId, groupKey, message.taskId, thread => {
    const id = message.id || message.turnId || `msg-${crypto.randomUUID()}`;
    if (thread.checkpoint) {
      const turn = thread.checkpoint.turns.find(item => item.turnId === id || item.turnId === message.turnId);
      if (!turn?.entry || turn.entry.text !== message.text || turn.actorId !== message.actorId) throw groupError('CHECKPOINT_LEGACY_WRITE_BLOCKED', '版本化断点只能提交原计划中已保存的有效结果，旧继续逻辑不能接管');
    }
    const existing = thread.rounds.flatMap(round => round.messages).find(entry => entry.id === id || (message.turnId && entry.turnId === message.turnId));
    if (existing) {
      if (existing.text !== String(message.text ?? '') || existing.actorId !== message.actorId) throw groupError('GROUP_MESSAGE_ID_CONFLICT', '同一棒的提交内容不一致');
      return existing;
    }
    thread.label = groupLabel || thread.label;
    thread.currentRound = Math.max(thread.currentRound || 1, roundNumber || 1);
    let roundObj = thread.rounds.find(r => r.round === roundNumber);
    if (!roundObj) {
      roundObj = { round: roundNumber, title: `第 ${roundNumber} 轮`, subtitle: message.stageTitle || '', messages: [] };
      thread.rounds.push(roundObj);
    }
    if (message.stageTitle && !roundObj.subtitle) roundObj.subtitle = message.stageTitle;
    const entry = {
      ...message,
      id,
      at: message.at || new Date().toISOString(),
      sequence: Math.max(0, ...thread.rounds.flatMap(round => round.messages.map(entry => entry.sequence || 0))) + 1,
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
    return entry;
    });
  }

  bindingFile({ parentSessionId, taskId, groupId, groupKey }) {
    if (![parentSessionId, taskId, groupId, groupKey].every(value => typeof value === 'string' && value.length > 0)) throw groupError('GROUP_BINDING_IDENTITY', '组聊缺少主对话、任务或工作组标识');
    const hash = crypto.createHash('sha256').update(JSON.stringify([parentSessionId, taskId, groupId, groupKey])).digest('hex');
    return path.join(this.groupBindingsDir, `binding-${hash}.json`);
  }

  readGroupBinding(identity) {
    const file = this.bindingFile(identity);
    if (!fs.existsSync(file)) return null;
    const binding = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const key of ['parentSessionId', 'taskId', 'groupId', 'groupKey']) if (binding[key] !== identity[key]) throw groupError('GROUP_BINDING_IDENTITY', '组聊绑定归属不一致');
    return binding;
  }

  findGroupConversation(identity) {
    return this.readGroupBinding(identity);
  }

  readGroupProgress(sessionId, groupKey, taskId) {
    return this.readGroupThread(sessionId, groupKey, '工作组', taskId).progress ?? {};
  }

  saveGroupProgress(sessionId, groupKey, taskId, patch) {
    return this.mutateGroupThread(sessionId, groupKey, taskId, thread => {
    const queue = patch.queue ? mergeInstructionQueue(thread.progress?.queue, patch.queue) : thread.progress?.queue;
    thread.progress = { ...(thread.progress ?? {}), ...patch, ...(queue ? { queue } : {}) };
    return thread.progress;
    });
  }

  readGroupCheckpoint(sessionId, groupKey, taskId) {
    const checkpoint = this.readGroupThread(sessionId, groupKey, '工作组', taskId).checkpoint;
    if (!checkpoint) return null;
    if (checkpoint.version !== 1) throw groupError('CHECKPOINT_VERSION', '断点版本不受支持，只能查看，不能接续');
    if (checkpoint.sessionId !== sessionId || checkpoint.taskId !== taskId || checkpoint.groupKey !== groupKey) throw groupError('CHECKPOINT_IDENTITY', '断点任务或工作组归属不一致');
    if (!Array.isArray(checkpoint.turns) || !checkpoint.turns.length || new Set(checkpoint.turns.map(turn => turn.turnId)).size !== checkpoint.turns.length || checkpoint.turns.some(turn => !turn.turnId || !turn.actorId || !['pending', 'inflight', 'uncertain', 'result', 'completed', 'skipped'].includes(turn.state))) throw groupError('CHECKPOINT_ORDER_MISMATCH', '断点席位计划或完成证据不完整');
    if (checkpoint.turns.some((turn, index) => turn.state === 'skipped' && (turn.entry || !turn.skipReason
      || !checkpoint.turns.slice(index + 1).some(later => later.turnId === turn.passedByTurnId && later.entry?.text?.trim())))) throw groupError('CHECKPOINT_ORDER_MISMATCH', '历史空正文缺少后续有效进度证据');
    const first = checkpoint.turns.findIndex(turn => !['completed', 'skipped'].includes(turn.state));
    if ((checkpoint.nextTurnId ?? null) !== (first < 0 ? null : checkpoint.turns[first].turnId) || (first >= 0 && checkpoint.turns.slice(first + 1).some(turn => turn.state === 'completed'))) throw groupError('CHECKPOINT_ORDER_MISMATCH', '断点无法确定原讨论唯一下一席');
    return structuredClone(checkpoint);
  }

  ensureGroupCheckpoint(sessionId, groupKey, taskId, seed) {
    return this.mutateGroupThread(sessionId, groupKey, taskId, thread => {
    const prior = this.readGroupCheckpoint(sessionId, groupKey, taskId);
    if (prior?.meetingKey === seed.meetingKey) {
      for (const key of ['workspaceRoot', 'configFingerprint', 'inputFingerprint']) {
        if (prior[key] !== seed[key]) throw groupError('CHECKPOINT_CONTEXT_MISMATCH', `接续预检不通过：${key} 与原讨论不一致`);
      }
      if (JSON.stringify(prior.turns.map(({ turnId, actorId, phase, discussionRound }) => ({ turnId, actorId, phase, discussionRound }))) !== JSON.stringify(seed.turns.map(({ turnId, actorId, phase, discussionRound }) => ({ turnId, actorId, phase, discussionRound })))) throw groupError('CHECKPOINT_ORDER_MISMATCH', '原席位次序或轮次已改变，不能接续');
      return prior;
    }
    if (prior && prior.status !== 'completed') throw groupError('CHECKPOINT_ACTIVE_MEETING', '本组仍有未完成的原讨论，不能改轮次或重建逻辑身份');
    if (!taskId || !seed.meetingId || !seed.meetingKey || !seed.workspaceRoot || !seed.configFingerprint || !seed.inputFingerprint || !Array.isArray(seed.turns) || !seed.turns.length) throw groupError('CHECKPOINT_MATERIALS_MISSING', '断点缺少任务、讨论、工作区、输入校验或席位计划');
    if (!seed.taskInputs || typeof seed.taskInputs.userMessage !== 'string' || !seed.taskInputs.userMessage.trim() || typeof seed.taskInputs.goal !== 'string' || typeof seed.promptContext !== 'string' || !seed.promptContext.trim() || !seed.taskConfig) throw groupError('CHECKPOINT_MATERIALS_MISSING', '断点缺少原发起消息、任务栏文本、阶段简报或原席位配置');
    if (new Set(seed.turns.map(turn => turn.turnId)).size !== seed.turns.length || seed.turns.some(turn => !turn.turnId || !turn.actorId)) throw groupError('CHECKPOINT_ORDER_MISMATCH', '断点席位计划的稳定标识不唯一');
    if (prior) (thread.checkpointHistory ??= []).push(prior);
    thread.checkpoint = {
      ...structuredClone(seed), version: 1, sessionId, taskId, groupKey,
      status: 'active', createdAt: new Date().toISOString(),
      turns: seed.turns.map(turn => ({ ...structuredClone(turn), state: turn.state === 'skipped' ? 'skipped' : turn.entry?.text?.trim() ? 'result' : turn.sideEffectsUncertain ? 'uncertain' : 'pending', attempt: turn.attempt ?? 0, sideEffectsUncertain: Boolean(turn.sideEffectsUncertain) })),
      nextTurnId: seed.turns.find(turn => turn.state !== 'skipped')?.turnId ?? null, fault: seed.fault ?? null
    };
    return structuredClone(thread.checkpoint);
    });
  }

  updateGroupCheckpoint(sessionId, groupKey, taskId, mutator) {
    return this.mutateGroupThread(sessionId, groupKey, taskId, thread => {
    const checkpoint = this.readGroupCheckpoint(sessionId, groupKey, taskId);
    if (!checkpoint) throw groupError('CHECKPOINT_MISSING', '没有可接续的新版本断点，旧记录仅可查看');
    const identity = JSON.stringify([checkpoint.version, checkpoint.sessionId, checkpoint.taskId, checkpoint.groupKey, checkpoint.meetingId, checkpoint.meetingKey,
      checkpoint.turns.map(({ turnId, actorId, phase, discussionRound }) => [turnId, actorId, phase, discussionRound])]);
    const replacement = mutator(checkpoint, thread);
    const next = replacement ?? checkpoint;
    if (JSON.stringify([next.version, next.sessionId, next.taskId, next.groupKey, next.meetingId, next.meetingKey,
      next.turns.map(({ turnId, actorId, phase, discussionRound }) => [turnId, actorId, phase, discussionRound])]) !== identity) throw groupError('CHECKPOINT_IDENTITY', '断点逻辑身份和原席位计划不可修改');
    next.updatedAt = new Date().toISOString();
    thread.checkpoint = next;
    return structuredClone(next);
    });
  }

  manualSpeechResumeDescriptor(cp) {
    const turn = cp.turns.find(item => item.turnId === cp.nextTurnId);
    const unknown = cp.turns.filter(item => (item.state === 'uncertain' || item.sideEffectsUncertain) && !item.entry?.text?.trim());
    if (cp.status !== 'active' || !turn || turn.state !== 'uncertain' || turn.entry?.text?.trim()
      || unknown.length !== 1 || unknown[0] !== turn) return null;
    const identity = [cp.version, cp.sessionId, cp.taskId, cp.groupKey, cp.meetingId, cp.meetingKey,
      cp.configFingerprint, cp.inputFingerprint, cp.nextTurnId, cp.fault ?? null,
      turn.turnId, turn.actorId, turn.phase, turn.discussionRound, turn.attempt, turn.state,
      turn.startedAt ?? null, Boolean(turn.sideEffectsUncertain), turn.unresolvedToolAttempt ?? null];
    return { sessionId: cp.sessionId, taskId: cp.taskId, groupKey: cp.groupKey, checkpointId: cp.meetingId,
      turnId: turn.turnId, expectedAttempt: turn.attempt,
      fingerprint: crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex') };
  }

  authorizeManualSpeechResume(descriptor) {
    const cp = this.readGroupCheckpoint(descriptor.sessionId, descriptor.groupKey, descriptor.taskId);
    const current = cp && this.manualSpeechResumeDescriptor(cp);
    // A verified legacy preview may be materialized by the common resume path.
    // Its opaque token still cannot be consumed until the stored checkpoint matches.
    if (cp && (!current || JSON.stringify(current) !== JSON.stringify(descriptor))) throw groupError('CHECKPOINT_STALE_ATTEMPT', '正文接续断点已变化');
    const token = {};
    this.manualSpeechClaims.set(token, structuredClone(descriptor));
    return token;
  }

  matchesManualSpeechResume(token, descriptor) {
    return Boolean(token && descriptor && JSON.stringify(this.manualSpeechClaims.get(token)) === JSON.stringify(descriptor));
  }

  claimGroupTurn(sessionId, groupKey, taskId, turnId, { manualSpeechToken = null } = {}) {
    const checkpoint = this.updateGroupCheckpoint(sessionId, groupKey, taskId, (cp, thread) => {
      const turn = cp.turns.find(item => item.turnId === turnId);
      if (!turn || cp.nextTurnId !== turnId || cp.status !== 'active') throw groupError('CHECKPOINT_NOT_NEXT', '只能请求原讨论唯一下一席');
      if (turn.state === 'completed' || turn.entry) throw groupError('CHECKPOINT_RESULT_EXISTS', '本棒已有可靠结果，只能补交记录');
      const uncertain = turn.state === 'uncertain' || turn.sideEffectsUncertain;
      if (uncertain) {
        const descriptor = this.manualSpeechResumeDescriptor(cp);
        if (!this.matchesManualSpeechResume(manualSpeechToken, descriptor)) throw groupError('CHECKPOINT_SIDE_EFFECT_UNCERTAIN', '本棒调用中断且工具副作用无法核实，不自动重跑');
        this.manualSpeechClaims.delete(manualSpeechToken);
        turn.unresolvedToolAttempt ??= { attempt: turn.attempt, state: turn.state,
          sideEffectsUncertain: Boolean(turn.sideEffectsUncertain), startedAt: turn.startedAt ?? null,
          fault: structuredClone(cp.fault ?? null), diagnostics: structuredClone(thread.progress?.lastSpeechFailure ?? null),
          status: 'unverified' };
        turn.manualSpeechOnlyAttempt = (turn.attempt ?? 0) + 1;
        turn.sideEffectsUncertain = true;
      }
      turn.attempt = (turn.attempt ?? 0) + 1;
      turn.state = 'inflight';
      cp.currentRound = turn.discussionRound ?? 0;
      turn.startedAt = new Date().toISOString();
      cp.fault = null;
    });
    return checkpoint.turns.find(turn => turn.turnId === turnId);
  }

  markGroupTurnSideEffect(sessionId, groupKey, taskId, turnId) {
    return this.updateGroupCheckpoint(sessionId, groupKey, taskId, cp => {
      const turn = cp.turns.find(item => item.turnId === turnId);
      if (!turn || turn.state !== 'inflight' || cp.nextTurnId !== turnId) throw groupError('CHECKPOINT_NOT_NEXT', '工具调用不属于当前在途席位');
      // Persist before a tool may perform an external or workspace side effect.
      turn.sideEffectsUncertain = true;
    });
  }

  saveGroupToolProgress(sessionId, groupKey, taskId, turnId, attempt, progress) {
    return this.updateGroupCheckpoint(sessionId, groupKey, taskId, cp => {
      const turn = cp.turns.find(item => item.turnId === turnId);
      if (!turn || turn.state !== 'inflight' || cp.nextTurnId !== turnId || turn.attempt !== attempt) throw groupError('CHECKPOINT_STALE_ATTEMPT', '工具回执不属于当前席位尝试');
      turn.toolContinuation = structuredClone(progress);
    });
  }

  beginGroupToolCall(sessionId, groupKey, taskId, turnId, attempt, call, sideEffectRisk) {
    const cp = this.updateGroupCheckpoint(sessionId, groupKey, taskId, checkpoint => {
      const turn = checkpoint.turns.find(item => item.turnId === turnId);
      if (!turn || turn.state !== 'inflight' || checkpoint.nextTurnId !== turnId || turn.attempt !== attempt) throw groupError('CHECKPOINT_STALE_ATTEMPT', '工具调用不属于当前席位尝试');
      const prior = (turn.toolReceipts ??= []).find(item => item.id === call.id);
      if (prior) {
        if (prior.name !== call.name || JSON.stringify(prior.arguments) !== JSON.stringify(call.arguments)) throw groupError('CABINET_TOOL_CALL_CONFLICT', '同一工具调用 ID 对应不同参数');
        if (prior.status !== 'completed' && prior.sideEffectRisk) throw groupError('CHECKPOINT_SIDE_EFFECT_UNCERTAIN', '上次工具执行尚无可靠回执，不重复执行');
        return;
      }
      turn.toolReceipts.push({ id: call.id, name: call.name, arguments: structuredClone(call.arguments),
        attempt, sideEffectRisk, status: 'started', startedAt: new Date().toISOString() });
      if (sideEffectRisk) turn.sideEffectsUncertain = true;
    });
    return cp.turns.find(item => item.turnId === turnId).toolReceipts.find(item => item.id === call.id);
  }

  finishGroupToolCall(sessionId, groupKey, taskId, turnId, attempt, callId, message, record) {
    return this.updateGroupCheckpoint(sessionId, groupKey, taskId, cp => {
      const turn = cp.turns.find(item => item.turnId === turnId);
      if (!turn || turn.state !== 'inflight' || cp.nextTurnId !== turnId || turn.attempt !== attempt) throw groupError('CHECKPOINT_STALE_ATTEMPT', '工具结果不属于当前席位尝试');
      const receipt = turn.toolReceipts?.find(item => item.id === callId);
      if (!receipt) throw groupError('CABINET_TOOL_RECEIPT_MISSING', '工具结果缺少对应执行登记');
      Object.assign(receipt, { status: 'completed', completedAt: new Date().toISOString(),
        message: structuredClone(message), record: structuredClone(record ?? null) });
      turn.sideEffectsUncertain = Boolean(turn.unresolvedToolAttempt)
        || turn.toolReceipts.some(item => item.status !== 'completed' && item.sideEffectRisk);
    });
  }

  saveGroupTurnResult(sessionId, groupKey, taskId, turnId, entry, { attempt } = {}) {
    if (typeof entry?.text !== 'string' || !entry.text.trim()) throw groupError('CABINET_EMPTY_VISIBLE_BODY', '空可见正文不保存为有效结果，也不推进下一席');
    return this.updateGroupCheckpoint(sessionId, groupKey, taskId, cp => {
      const turn = cp.turns.find(item => item.turnId === turnId);
      if (!turn || entry.taskId !== taskId || entry.actorId !== turn.actorId || (entry.turnId ?? entry.id) !== turnId || entry.groupKey !== groupKey || entry.stageKey !== cp.meetingKey || entry.phase !== turn.phase || entry.discussionRound !== turn.discussionRound) throw groupError('CHECKPOINT_RESULT_IDENTITY', '结果不属于本任务、本讨论和原席位');
      if (attempt !== undefined && turn.attempt !== attempt) throw groupError('CHECKPOINT_STALE_ATTEMPT', '迟到结果不属于当前重试，已拒绝');
      if (turn.entry) {
        if (turn.entry.text !== entry.text || turn.entry.actorId !== entry.actorId) throw groupError('GROUP_MESSAGE_ID_CONFLICT', '同一棒已保存的可靠结果不一致');
        return;
      }
      if (cp.nextTurnId !== turnId || cp.status !== 'active') throw groupError('CHECKPOINT_NOT_NEXT', '迟到结果不能污染已推进或已结束的讨论');
      if (turn.manualSpeechOnlyAttempt === turn.attempt && entry.toolRecords?.length) throw groupError('CABINET_SPEECH_ONLY_BLOCKED', '正文接续不能包含新的工具执行');
      turn.entry = { ...structuredClone(entry), id: turnId, turnId, taskId, groupKey };
      turn.state = 'result'; turn.sideEffectsUncertain = Boolean(turn.unresolvedToolAttempt);
      turn.resultAt = new Date().toISOString(); cp.fault = null;
    });
  }

  recordGroupTurnFailure(sessionId, groupKey, taskId, turnId, { code, reason, sideEffectsUncertain = false, attempt } = {}) {
    return this.updateGroupCheckpoint(sessionId, groupKey, taskId, cp => {
      const turn = cp.turns.find(item => item.turnId === turnId);
      if (!turn || turn.state === 'completed') return;
      if (attempt !== undefined && turn.attempt !== attempt) return;
      turn.sideEffectsUncertain = Boolean(turn.unresolvedToolAttempt) || !turn.entry && (turn.sideEffectsUncertain || sideEffectsUncertain);
      turn.state = turn.entry ? 'result' : turn.sideEffectsUncertain ? 'uncertain' : 'pending';
      cp.fault = { turnId, actorId: turn.actorId, phase: turn.phase, discussionRound: turn.discussionRound,
        code: code || 'CHECKPOINT_TURN_FAILED', reason: String(reason || '本棒未完成'), at: new Date().toISOString() };
    });
  }

  async withGroupLease(sessionId, groupKey, taskId, operation) {
    return serializeGroup(`lease:${this.groupFile(sessionId, groupKey, taskId)}`, operation);
  }

  collectTaskAssets(parentSessionId, taskId) {
    const internalFiles = [];
    const nativeSessions = [];
    const scanJson = (dir, match) => {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter(n => n.endsWith('.json')).flatMap(name => {
        const file = path.join(dir, name);
        try {
          const data = JSON.parse(fs.readFileSync(file, 'utf8'));
          return match(data) ? [{ file, data }] : [];
        } catch {
          return [];
        }
      });
    };
    for (const item of scanJson(this.groupStoreDir, d => d?.sessionId === parentSessionId && d?.taskId === taskId)) {
      internalFiles.push(item.file);
    }
    for (const item of scanJson(this.groupBindingsDir, d => d?.parentSessionId === parentSessionId && d?.taskId === taskId)) {
      internalFiles.push(item.file);
      const sid = item.data.childSessionId || item.data.nativeSessionId;
      if (sid) nativeSessions.push(sid);
    }
    for (const item of scanJson(this.originalStoreDir, d => d?.sessionId === parentSessionId && d?.taskId === taskId)) {
      if (item.data.kind === 'formal-delivery' || item.data.kind === 'secretary-final') continue;
      internalFiles.push(item.file);
    }
    return { internalFiles, nativeSessions };
  }

  validateGroupSpeech(binding, event, plannedTurn = null, checkpoint = null) {
    if (['parentSessionId', 'taskId', 'groupId', 'groupKey', 'childSessionId'].some(key => event.data?.[key] !== binding[key])) throw groupError('GROUP_MESSAGE_IDENTITY', '原生发言任务、讨论或工作组归属不一致');
    const entry = event.data.entry;
    if (!entry || entry.taskId !== binding.taskId) throw groupError('GROUP_MESSAGE_IDENTITY', '原生发言正文的任务归属不一致');
    // Older speech stores group ownership on the verified event envelope only.
    // An explicit inner value must agree; absence does not change ownership.
    const groupKey = Object.hasOwn(entry, 'groupKey') ? entry.groupKey : event.data.groupKey;
    if (groupKey !== binding.groupKey) throw groupError('GROUP_MESSAGE_IDENTITY', '原生发言正文的工作组归属不一致');
    if (checkpoint) {
      if (!plannedTurn || entry.id !== plannedTurn.turnId || entry.turnId !== plannedTurn.turnId || entry.actorId !== plannedTurn.actorId || entry.stageKey !== checkpoint.meetingKey || entry.phase !== plannedTurn.phase || entry.discussionRound !== plannedTurn.discussionRound || typeof entry.text !== 'string' || !entry.text.trim()) throw groupError('GROUP_MESSAGE_IDENTITY', '原生发言的席位、讨论、轮次或有效正文与原断点不一致');
      if (plannedTurn.entry && entry.text !== plannedTurn.entry.text) throw groupError('GROUP_MESSAGE_ID_CONFLICT', '同一棒已保存的结果与原生发言正文不一致');
    }
    return entry;
  }

  async readGroupSpeech(binding, turnId) {
    const snapshot = await this.ctx.sessionQuery.readSession(binding.childSessionId);
    if (snapshot.session?.id !== binding.childSessionId || snapshot.inheritedEventCount !== 0) throw groupError('NATIVE_GROUP_OWNERSHIP', '原生讨论归属或继承历史不一致');
    const checkpoint = this.readGroupCheckpoint(binding.parentSessionId, binding.groupKey, binding.taskId);
    const plannedTurn = checkpoint?.turns.find(turn => turn.turnId === turnId);
    const events = snapshot.events.filter(event => event.type === NS + 'speech' && (event.data.entry?.id === turnId || event.data.entry?.turnId === turnId));
    for (const event of events) {
      this.validateGroupSpeech(binding, event, plannedTurn, checkpoint);
    }
    if (events.length > 1 && events.some(event => event.data.entry.text !== events[0].data.entry.text || event.data.entry.actorId !== events[0].data.entry.actorId)) throw groupError('GROUP_MESSAGE_ID_CONFLICT', '同一棒存在不一致的原生发言');
    return events[0] ?? null;
  }

  async completeGroupTurn(binding, turnId) {
    let checkpoint = this.readGroupCheckpoint(binding.parentSessionId, binding.groupKey, binding.taskId);
    let turn = checkpoint?.turns.find(item => item.turnId === turnId);
    if (!turn) throw groupError('CHECKPOINT_NOT_NEXT', '原断点没有这一棒');
    if (turn.state === 'completed') {
      if (!turn.entry?.text?.trim()) throw groupError('CHECKPOINT_RESULT_MISSING', '已完成棒次缺少可靠正文');
      this.appendGroupMessage(binding.parentSessionId, binding.groupKey, binding.groupLabel, turn.discussionRound || 1, turn.entry);
      await this.commitGroupMessage(binding, turn.entry);
      return turn;
    }
    if (checkpoint.nextTurnId !== turnId) throw groupError('CHECKPOINT_NOT_NEXT', '必须先补交原讨论下一棒');
    if (!turn.entry?.text?.trim()) throw groupError('CHECKPOINT_RESULT_MISSING', '本棒没有可靠的有效结果，不能仅凭发起过请求推进');
    const meetingId = checkpoint.meetingId;
    const entry = this.appendGroupMessage(binding.parentSessionId, binding.groupKey, binding.groupLabel, turn.discussionRound || 1, turn.entry);
    const committed = await this.commitGroupMessage(binding, entry);
    // Reload after native I/O. A replaced task/meeting must never accept a late result.
    return this.mutateGroupThread(binding.parentSessionId, binding.groupKey, binding.taskId, thread => {
    checkpoint = thread.checkpoint;
    turn = checkpoint?.turns.find(item => item.turnId === turnId);
    if (!turn || checkpoint.meetingId !== meetingId || checkpoint.nextTurnId !== turnId || checkpoint.status !== 'active') throw groupError('CHECKPOINT_STALE_RESULT', '原讨论已变化，拒绝迟到提交');
    turn.state = 'completed'; turn.completedAt = new Date().toISOString();
    turn.entry = { ...turn.entry, nativeCommitted: true, nativeSeq: committed.seq };
    turn.sideEffectsUncertain = Boolean(turn.unresolvedToolAttempt);
    for (const instruction of thread.progress?.queue ?? []) {
      if ((turn.entry.guidanceIds ?? []).includes(instruction.id)) {
        instruction.status = 'delivered'; instruction.deliveredAt ??= turn.completedAt;
      }
    }
    checkpoint.nextTurnId = checkpoint.turns.find(item => !['completed', 'skipped'].includes(item.state))?.turnId ?? null;
    checkpoint.currentRound = turn.discussionRound ?? 0;
    if (checkpoint.fault?.turnId === turnId) checkpoint.fault = null;
    return structuredClone(turn);
    });
  }

  async reconcileGroupCheckpoint(binding) {
    let checkpoint = this.readGroupCheckpoint(binding.parentSessionId, binding.groupKey, binding.taskId);
    if (!checkpoint) throw groupError('CHECKPOINT_MISSING', '旧记录没有版本化断点，不能自动迁移或执行');
    for (const turn of checkpoint.turns.filter(item => item.state === 'completed')) await this.completeGroupTurn(binding, turn.turnId);
    while (checkpoint.nextTurnId) {
      const turn = checkpoint.turns.find(item => item.turnId === checkpoint.nextTurnId);
      if (!turn) throw groupError('CHECKPOINT_ORDER_MISMATCH', '无法确定唯一下一席');
      if (!turn.entry) {
        const local = this.readGroupThread(binding.parentSessionId, binding.groupKey, binding.groupLabel, binding.taskId).rounds.flatMap(round => round.messages)
          .find(entry => entry.turnId === turn.turnId || entry.id === turn.turnId);
        let original = null;
        const names = turn.sourceId ? [`${turn.sourceId}.json`] : fs.readdirSync(this.originalStoreDir).filter(name => /^[a-zA-Z0-9_-]+\.json$/.test(name));
        for (const name of names) {
          if (!/^[a-zA-Z0-9_-]+\.json$/.test(name) || !fs.existsSync(path.join(this.originalStoreDir, name))) continue;
          const candidate = JSON.parse(fs.readFileSync(path.join(this.originalStoreDir, name), 'utf8'));
          if (candidate.sessionId === binding.parentSessionId && candidate.taskId === binding.taskId && candidate.groupKey === binding.groupKey && candidate.turnId === turn.turnId && candidate.actorId === turn.actorId && candidate.stageKey === checkpoint.meetingKey && candidate.text?.trim()) { original = candidate; break; }
        }
        const native = await this.readGroupSpeech(binding, turn.turnId);
        const candidates = [local, original, native?.data.entry].filter(entry => entry?.text?.trim());
        if (!candidates.length) break;
        if (candidates.some(entry => entry.text !== candidates[0].text || entry.actorId !== candidates[0].actorId)) throw groupError('GROUP_MESSAGE_ID_CONFLICT', '本地原稿与原生发言不一致，不能自动选择');
        this.saveGroupTurnResult(binding.parentSessionId, binding.groupKey, binding.taskId, turn.turnId, candidates[0]);
      }
      await this.completeGroupTurn(binding, turn.turnId);
      checkpoint = this.readGroupCheckpoint(binding.parentSessionId, binding.groupKey, binding.taskId);
    }
    return checkpoint;
  }

  findGroupByChildSession(childSessionId) {
    return this.childBindings.get(childSessionId) ?? null;
  }

  async groupAgent(binding) {
    let agent = this.ctx?.agents?.get?.(binding.childSessionId);
    if (!agent) {
      const resolved = await this.ctx.sessionController.resolveAgent(binding.childSessionId);
      if (!resolved?.agent) throw groupError('GROUP_AGENT_UNAVAILABLE', '本组原生对话暂时无法恢复', resolved?.error);
      agent = resolved.agent;
    }
    if (agent.id !== binding.childSessionId || agent.session?.id !== binding.childSessionId) throw groupError('GROUP_AGENT_IDENTITY', '原生组聊恢复到错误对话');
    return agent;
  }

  async flushNativeSession(session) {
    let store;
    try { store = this.ctx?.get?.('sessions') ?? this.ctx?.sessions; } catch { store = this.ctx?.sessions; }
    if (typeof store?.flush !== 'function') throw groupError('NATIVE_FLUSH_UNAVAILABLE', '宿主会话落盘确认接口不可用，已保留结果并停止推进');
    await store.flush(session);
  }

  async ensureGroupConversation(identity) {
    const file = this.bindingFile(identity);
    return serializeGroup(file, async () => {
      let binding = this.readGroupBinding(identity);
      if (binding && !['created', 'ready'].includes(binding.state)) throw groupError(binding.state === 'creating' ? 'NATIVE_GROUP_CREATE_UNCERTAIN' : 'NATIVE_GROUP_BLOCKED', binding.reason || '原生对话创建结果不确定，请先核对该次创建');
      if (!binding) {
        const list = await this.ctx.sessionQuery.listSessions();
        if (!Array.isArray(list) || list.some(item => typeof item.header?.id !== 'string')) throw groupError('NATIVE_GROUP_LIST_UNAVAILABLE', '无法核对原生会话创建前清单');
        const preexistingSessionIds = list.map(item => item.header.id);
        binding = {
          version: 1, state: 'creating', parentSessionId: identity.parentSessionId, taskId: identity.taskId,
          groupId: identity.groupId, groupKey: identity.groupKey, groupLabel: identity.groupLabel || '工作组',
          workspaceRoot: path.resolve(identity.workspaceRoot || process.cwd()), creationAttemptId: crypto.randomUUID(),
          createdAt: new Date().toISOString(), preexistingSessionIds,
        };
        let reservation;
        try {
          reservation = fs.openSync(file, 'wx');
          fs.writeFileSync(reservation, JSON.stringify(binding, null, 2) + '\n', 'utf8');
        } catch (error) {
          if (error.code === 'EEXIST') throw groupError('NATIVE_GROUP_CREATION_IN_PROGRESS', '另一处已开始创建本组对话，请读取该次创建的绑定后重试', error);
          throw error;
        } finally {
          if (reservation !== undefined) fs.closeSync(reservation);
        }
        let result;
        try {
          result = await this.ctx.sessionController.create({ cwd: binding.workspaceRoot });
        } catch (error) {
          binding.reason = '创建请求已发出但结果不确定，未自动重建'; writeJson(file, binding);
          throw groupError('NATIVE_GROUP_CREATE_UNCERTAIN', binding.reason, error);
        }
        if (!result?.sessionId || result.sessionId === binding.parentSessionId || preexistingSessionIds.includes(result.sessionId)) {
          binding.state = 'blocked'; binding.reason = '原生创建返回已有对话，无法证明新子对话归属'; binding.createResult = result ?? null; writeJson(file, binding);
          throw groupError('NATIVE_GROUP_NOT_FRESH', binding.reason);
        }
        binding = { ...binding, state: 'created', childSessionId: result.sessionId, nativeSessionId: result.sessionId, createResult: result };
        writeJson(file, binding);
      }
      const snapshot = await this.ctx.sessionQuery.readSession(binding.childSessionId);
      if (snapshot.session.id !== binding.childSessionId || snapshot.inheritedEventCount !== 0) throw groupError('NATIVE_GROUP_OWNERSHIP', '子对话归属或继承历史校验失败');
      const agent = await this.groupAgent(binding);
      const ownership = snapshot.events.find(event => event.type === NS + 'group-binding');
      if (ownership) {
        const owned = ownership.data;
        if (['parentSessionId', 'taskId', 'groupId', 'groupKey', 'creationAttemptId'].some(key => owned[key] !== binding[key])) throw groupError('NATIVE_GROUP_OWNERSHIP', '原生子对话已有其他工作组归属');
      } else if (binding.state === 'ready') {
        throw groupError('NATIVE_GROUP_OWNERSHIP', '已保存绑定的原生归属记录丢失，已停止');
      } else {
        await appendPluginRecord(agent.session, NS + 'group-binding', {
          version: 1, parentSessionId: binding.parentSessionId, taskId: binding.taskId,
          groupId: binding.groupId, groupKey: binding.groupKey, groupLabel: binding.groupLabel,
          childSessionId: binding.childSessionId, nativeSessionId: binding.childSessionId, creationAttemptId: binding.creationAttemptId,
        }, this.nativeAppend);
      }
      await this.flushNativeSession(agent.session);
      binding.state = 'ready'; writeJson(file, binding);
      this.childBindings.set(binding.childSessionId, binding);
      this.mutateGroupThread(binding.parentSessionId, binding.groupKey, binding.taskId, thread => {
        thread.nativeSessionId = binding.childSessionId; thread.binding = binding;
      });
      await this.onGroupConversation?.(binding, agent);
      return binding;
    });
  }

  async commitGroupMessage(binding, entry) {
    const saved = this.readGroupBinding(binding);
    if (!saved || saved.state !== 'ready' || saved.childSessionId !== binding.childSessionId) throw groupError('GROUP_BINDING_NOT_READY', '本组原生对话尚未就绪');
    if (entry.taskId && entry.taskId !== binding.taskId) throw groupError('GROUP_MESSAGE_IDENTITY', '发言任务归属不一致');
    const messageId = entry.id || entry.turnId;
    if (!messageId) throw groupError('GROUP_MESSAGE_ID_REQUIRED', '组聊发言缺少稳定标识');
    const checkpoint = this.readGroupCheckpoint(binding.parentSessionId, binding.groupKey, binding.taskId);
    if (checkpoint) {
      const turn = checkpoint.turns.find(item => item.turnId === messageId || item.turnId === entry.turnId);
      if (!turn?.entry || turn.entry.text !== entry.text || turn.actorId !== entry.actorId) throw groupError('CHECKPOINT_LEGACY_WRITE_BLOCKED', '旧继续逻辑不能向本次版本化讨论追加发言');
    }
    return serializeGroup(`${this.bindingFile(binding)}:speech`, async () => {
      const readExisting = () => this.readGroupSpeech(binding, messageId);
      let existing = await readExisting();
      if (existing && (existing.data.entry.text !== entry.text || existing.data.entry.actorId !== entry.actorId)) throw groupError('GROUP_MESSAGE_ID_CONFLICT', '同一棒的原生提交内容不一致');
      let seq = existing?.seq;
      if (!existing) {
        const agent = await this.groupAgent(binding);
        await this.onGroupConversation?.(binding, agent);
        try {
          seq = await appendPluginRecord(agent.session, NS + 'speech', {
            version: 1, parentSessionId: binding.parentSessionId, taskId: binding.taskId,
            groupId: binding.groupId, groupKey: binding.groupKey, groupLabel: binding.groupLabel,
            childSessionId: binding.childSessionId, entry: { ...entry, id: messageId },
          }, this.nativeAppend);
        } catch (error) {
          existing = await readExisting();
          if (!existing) throw groupError('NATIVE_GROUP_COMMIT_FAILED', '发言已保存在本地，原生提交未确认；重试将补交这一棒', error);
          if (existing.data.entry.text !== entry.text || existing.data.entry.actorId !== entry.actorId) throw groupError('GROUP_MESSAGE_ID_CONFLICT', '同一棒的原生提交内容不一致');
          seq = existing.seq;
        }
      }
      const committedAgent = await this.groupAgent(binding);
      await this.flushNativeSession(committedAgent.session);
      this.mutateGroupThread(binding.parentSessionId, binding.groupKey, binding.taskId, thread => {
        const local = thread.rounds.flatMap(round => round.messages).find(message => message.id === messageId || (entry.turnId && message.turnId === entry.turnId));
        if (local) { local.nativeCommitted = true; local.nativeSeq = seq; }
      });
      return { ok: true, messageId, seq, duplicate: Boolean(existing) };
    });
  }

  async appendMainAssistantMessage(parentAgent, { messageId = `cab-msg-${crypto.randomUUID()}`, title, groupLabel, actorLabel, role, participantId, providerId, modelId, phase, groupKey = null, formalVersion = null, text, sourceId = null, taskId = null, beforeAppend = null }) {
    const bodyText = String(text ?? '').trim();
    if (!parentAgent?.session?.append || !bodyText) throw groupError('MAIN_HANDOFF_UNAVAILABLE', '主对话不可写或正式成果为空');
    return serializeGroup(`main:${parentAgent.id}:${messageId}`, async () => {
      const snapshot = parentAgent.session.snapshotEvents();
      const existing = snapshot.find(event => event.type === 'user/message' && event.data.id === messageId);
      if (existing && (existing.data.source?.kind !== 'cabinet-relay' || existing.data.source.taskId !== taskId || existing.data.content?.map(part => part.text || '').join('') !== bodyText)) throw groupError('MAIN_HANDOFF_ID_CONFLICT', '同一交接标识的正式成果或任务归属不一致');
      if (!existing) {
        // Keep the freshness check beside the actual append: the serialized
        // operation may have waited since the orchestrator requested handoff.
        beforeAppend?.();
        parentAgent.session.append('user/message', {
          id: messageId,
          role: 'user',
          source: {
            kind: 'cabinet-relay', form: 'relay', groupLabel: groupLabel || title || '工作组',
            actorLabel: actorLabel || title || '组长', taskId, groupKey, formalVersion,
          },
          content: [{ type: 'text', text: bodyText }]
        }, { surfaceOp: 'append' });
      }
      if (!parentAgent.session.snapshotEvents().some(event => event.type === NS + 'presentation' && event.data.messageId === messageId)) {
        await appendPluginRecord(parentAgent.session, NS + 'presentation', {
          messageId,
          sourceId: sourceId || messageId,
          sessionId: parentAgent.id,
          title: title || '',
          role: role || '',
          participantId: participantId || '',
          provider: providerId || 'cabinet',
          model: modelId || 'cabinet',
          phase: phase || '',
          taskId,
          groupKey,
          formalVersion,
          at: new Date().toISOString()
        }, this.nativeAppend);
      }
      await this.flushNativeSession(parentAgent.session);
      return { ok: true, messageId, duplicate: Boolean(existing) };
    });
  }
}
