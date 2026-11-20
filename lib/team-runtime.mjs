import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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

const TEAM_COORDINATION_TOOL_RE = /^(?:send_message|list_agents|subagent|subagent_fork|team_|agent_team|create_task|update_task|claim_task|board_)/i;
const FILE_MUTATION_TOOL_RE = /(?:^|_)(?:write|write_file|create_file|edit|edit_file|multi_edit|patch|apply_patch|delete|delete_file|remove|remove_file|move|move_file|copy|replace|rename_file|notebook_edit)(?:$|_)/i;
const SHELL_EXEC_TOOL_RE = /(?:^|_)(?:pwsh|powershell|bash|sh|zsh|cmd|shell|run_command|execute_command|terminal|exec)(?:$|_)/i;
// dsh-ops PTC 模式下 run_code 是唯一传输入口，里面嵌套的 tools.ops_* 会再次触发 tools/pre-execute 逐个检查，
// 所以 run_code 本身只做 JS 层面的逃逸写盘静态拦截。
const RUN_CODE_TOOL_RE = /^run_code$/i;
const JS_ESCAPE_WRITE_RE = /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|unlink(?:Sync)?|rmSync|rmdir(?:Sync)?|mkdir(?:Sync)?|copyFile(?:Sync)?|rename(?:Sync)?|truncate(?:Sync)?|createWriteStream|child_process|spawn(?:Sync)?|execSync|execFile(?:Sync)?)\b/;

export function evaluateRunCodeProgram(binding, args = {}) {
  const code = typeof args?.code === 'string' ? args.code : '';
  if (binding?.allowWrite) return { allowed: true };
  if (JS_ESCAPE_WRITE_RE.test(code)) {
    return {
      allowed: false,
      code: 'CABINET_RUNCODE_ESCAPE_DENIED',
      reason: `当前席位（${binding.roleBadge || binding.role}）为只读模式，run_code 程序中不得直接使用 fs 写入/删除或子进程调用；请改用 tools.ops_glob / tools.ops_grep / tools.ops_read_files / tools.ops_inspect_local_file 等只读工具。`
    };
  }
  return { allowed: true };
}

function extractCommandString(args = {}) {
  if (!args || typeof args !== 'object') return String(args || '');
  for (const key of ['command', 'cmd', 'script', 'code', 'CommandLine', 'input']) {
    if (typeof args[key] === 'string' && args[key].trim()) return args[key].trim();
  }
  if (Array.isArray(args.args)) return args.args.join(' ');
  return '';
}

export function isMutatingShellCommand(commandText = '') {
  const raw = String(commandText || '').trim();
  if (!raw) return { mutating: false, reason: '' };

  // 先剥离安全的流合并与空设备重定向，以及比较/箭头操作符
  const scrubbed = raw
    .replace(/\b[12]?>&\s*[12]\b/g, ' ')
    .replace(/\b[12]?>+\s*(?:\$null|\/dev\/null|nul)\b/gi, ' ')
    .replace(/=[>]|->/g, ' ');

  const rules = [
    {
      re: /(?:^|[\s;|&()])(?:\d?>>|\d?>(?![>&=]))/,
      reason: '包含文件重定向写入操作符 (> / >>)'
    },
    {
      re: /\b(?:Set-Content|Add-Content|Out-File|Clear-Content|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item)\b/i,
      reason: '包含 PowerShell 文件写删 Cmdlet'
    },
    {
      re: /(?:^|[\s;|&()])(?:rm|del|erase|rmdir|rd|mkdir|md|mv|cp|ren|touch|truncate|tee|sc|ac|ni|ri|mi|ci|rni)(?=$|[\s;|&()])/i,
      reason: '包含文件创建、移动、复制或删除命令'
    },
    {
      re: /\bgit\s+(?:add|commit|push|pull|reset|checkout|switch|restore|clean|apply|am|stash|merge|rebase|cherry-pick|revert|mv|rm| init|clone)\b/i,
      reason: '包含修改 Git 仓库状态的命令'
    },
    {
      re: /\b(?:sed\s+-i|perl\s+-[pi]+e)\b/i,
      reason: '包含原地文本替换命令'
    },
    {
      re: /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|remove|uninstall|update|up|init|create|link|unlink|publish)\b/i,
      reason: '包含包管理器安装或写盘命令'
    },
    {
      re: /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|unlinkSync|unlink|rmSync|rmdirSync|mkdirSync|copyFileSync|renameSync)\b/,
      reason: '包含内联脚本文件写删调用'
    },
    {
      re: /\bopen\s*\([^)]*,\s*['"][wax+]/i,
      reason: '包含 Python 写模式打开文件调用'
    }
  ];

  for (const r of rules) {
    if (r.re.test(scrubbed)) {
      return { mutating: true, reason: r.reason };
    }
  }
  return { mutating: false, reason: '' };
}

function normalizeRelPath(p, workspaceRoot = '') {
  const raw = String(p || '').trim().replace(/^['"]|['"]$/g, '');
  if (!raw) return '';
  const root = workspaceRoot ? path.resolve(workspaceRoot) : process.cwd();
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  const rel = path.relative(root, abs).replace(/\\/g, '/');
  return rel;
}

function isPathAllowedByShard(targetPath, ownedPaths = [], workspaceRoot = '') {
  if (!Array.isArray(ownedPaths) || ownedPaths.length === 0) return true;
  if (ownedPaths.includes('*') || ownedPaths.includes('.')) return true;
  const relTarget = normalizeRelPath(targetPath, workspaceRoot).toLowerCase();
  if (!relTarget || relTarget.startsWith('..')) return false;

  for (const rawAllowed of ownedPaths) {
    const cleanAllowed = String(rawAllowed || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+\*?$/, '').toLowerCase();
    if (!cleanAllowed) continue;
    if (relTarget === cleanAllowed || relTarget.startsWith(`${cleanAllowed}/`)) return true;
    const normAllowed = normalizeRelPath(rawAllowed, workspaceRoot).replace(/\/+\*?$/, '').toLowerCase();
    if (normAllowed && (relTarget === normAllowed || relTarget.startsWith(`${normAllowed}/`))) return true;
  }
  return false;
}

function extractTargetPathsFromArgs(args = {}) {
  if (!args || typeof args !== 'object') return [];
  const paths = [];
  for (const k of ['path', 'filePath', 'file_path', 'file', 'target', 'targetFile', 'destination', 'to', 'source', 'from']) {
    if (typeof args[k] === 'string' && args[k].trim()) paths.push(args[k].trim());
  }
  if (Array.isArray(args.files)) {
    for (const f of args.files) {
      if (typeof f === 'string') paths.push(f);
      else if (f && typeof f.path === 'string') paths.push(f.path);
    }
  }
  return paths;
}

export function evaluateSeatToolExecution(binding, toolName = '', toolArgs = {}) {
  if (!binding) return { allowed: true };
  const name = String(toolName || '').trim();
  if (!name) return { allowed: true };

  if (TEAM_COORDINATION_TOOL_RE.test(name)) {
    return {
      allowed: false,
      code: 'CABINET_TEAM_TOOL_DENIED',
      reason: `内阁席位由编排器统一调度，禁止自行调用队友通信、任务板或子智能体工具（${name}）。`
    };
  }

  if (RUN_CODE_TOOL_RE.test(name)) {
    return evaluateRunCodeProgram(binding, toolArgs);
  }

  const isFileMutation = FILE_MUTATION_TOOL_RE.test(name);
  const isShellExec = SHELL_EXEC_TOOL_RE.test(name);

  if (!binding.allowWrite) {
    if (isFileMutation) {
      return {
        allowed: false,
        code: 'CABINET_READONLY_WRITE_DENIED',
        reason: `当前席位（${binding.roleBadge || binding.role}）处于只读模式，禁止调用文件修改工具（${name}）。`
      };
    }
    if (isShellExec) {
      if (binding.role === 'review') {
        const cmdStr = extractCommandString(toolArgs);
        const check = isMutatingShellCommand(cmdStr);
        if (check.mutating) {
          return {
            allowed: false,
            code: 'CABINET_REVIEW_MUTATING_SHELL_DENIED',
            reason: `审验席仅允许使用 Shell 执行只读查询、编译检查与测试验证，已拦截写盘/改仓命令（${check.reason}）。`
          };
        }
        return { allowed: true };
      }
      return {
        allowed: false,
        code: 'CABINET_READONLY_SHELL_DENIED',
        reason: `当前席位（${binding.roleBadge || binding.role}）处于纯只读设计/规划/汇报模式，禁止执行 Shell 命令（${name}），请使用只读文件工具查阅代码。`
      };
    }
    return { allowed: true };
  }

  // allowWrite === true：若配置了分片施工路径白名单，校验写文件目标路径
  if (isFileMutation && Array.isArray(binding.ownedPaths) && binding.ownedPaths.length > 0) {
    const targetPaths = extractTargetPathsFromArgs(toolArgs);
    for (const tp of targetPaths) {
      if (!isPathAllowedByShard(tp, binding.ownedPaths, binding.workspaceRoot)) {
        return {
          allowed: false,
          code: 'CABINET_SHARD_PATH_DENIED',
          reason: `分片施工路径越界：当前施工席仅被授权修改 [${binding.ownedPaths.join(', ')}]，禁止修改「${tp}」。`
        };
      }
    }
  }

  return { allowed: true };
}

function runGitSafe(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return null;
  }
}

function scanDirectoryFingerprint(rootDir) {
  const entries = [];
  const walk = (dir, depth = 0) => {
    if (depth > 2) return;
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of list) {
      if (d.name === '.git' || d.name === 'node_modules' || d.name === 'dist' || d.name === '.DS_Store') continue;
      const full = path.join(dir, d.name);
      const rel = path.relative(rootDir, full).replace(/\\/g, '/');
      if (d.isDirectory()) {
        walk(full, depth + 1);
      } else if (d.isFile()) {
        try {
          const st = fs.statSync(full);
          entries.push({ path: rel, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
        } catch {}
      }
    }
  };
  walk(rootDir, 0);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const hash = crypto.createHash('sha1').update(JSON.stringify(entries)).digest('hex');
  return { files: entries, hash };
}

export function captureWorkspaceSnapshot(cwd = process.cwd()) {
  const root = path.resolve(cwd || process.cwd());
  const insideGit = runGitSafe(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
  if (insideGit) {
    const head = runGitSafe(root, ['rev-parse', '--short', 'HEAD']) || 'UNCOMMITTED';
    const status = runGitSafe(root, ['status', '--porcelain']) || '';
    const diffStat = runGitSafe(root, ['diff', '--stat']) || '';
    const diffRaw = runGitSafe(root, ['diff']) || '';
    const fingerprint = crypto.createHash('sha1').update(`${head}\n${status}\n${diffRaw}`).digest('hex');
    return {
      cwd: root,
      isGit: true,
      head,
      status,
      diffStat,
      diffSample: diffRaw.slice(0, 12000),
      fingerprint,
      at: new Date().toISOString()
    };
  }
  const scan = scanDirectoryFingerprint(root);
  return {
    cwd: root,
    isGit: false,
    files: scan.files,
    fingerprint: scan.hash,
    at: new Date().toISOString()
  };
}

export function collectConstructionEvidence(cwd = process.cwd(), beforeSnap = null) {
  const afterSnap = captureWorkspaceSnapshot(cwd);
  const changed = !beforeSnap || beforeSnap.fingerprint !== afterSnap.fingerprint;
  const lines = [
    `【工作区真实工程实证包（由编排器自动采集）】`,
    `- 工作区路径：${afterSnap.cwd}`,
    `- 施工前后工作区状态变更：${changed ? '已检测到真实文件变更' : '未检测到文件落盘变更（若本任务要求修改代码/文件，请重点核查是否漏改）'}`
  ];

  if (afterSnap.isGit) {
    lines.push(`- Git HEAD：${afterSnap.head}`);
    lines.push(`- git status --porcelain：\n${afterSnap.status ? afterSnap.status : '（工作区干净，无未提交改动）'}`);
    if (afterSnap.diffStat) {
      lines.push(`- git diff --stat：\n${afterSnap.diffStat}`);
    }
    if (afterSnap.diffSample) {
      const truncated = afterSnap.diffSample.length >= 12000 ? '\n…（diff 较长，后续内容可通过只读文件工具直接查阅源码）' : '';
      lines.push(`- git diff 核心变更摘要：\n\`\`\`diff\n${afterSnap.diffSample}${truncated}\n\`\`\``);
    }
    // 补充未跟踪的新建文件摘要
    const untracked = (afterSnap.status || '')
      .split(/\r?\n/)
      .filter(l => l.startsWith('?? '))
      .map(l => l.slice(3).trim().replace(/^"|"$/g, ''))
      .filter(Boolean)
      .slice(0, 5);
    for (const rel of untracked) {
      try {
        const full = path.resolve(afterSnap.cwd, rel);
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          const content = fs.readFileSync(full, 'utf8').slice(0, 2000);
          lines.push(`- 新增未跟踪文件「${rel}」内容摘要：\n\`\`\`\n${content}\n\`\`\``);
        }
      } catch {}
    }
  } else {
    const beforeMap = new Map((beforeSnap?.files || []).map(f => [f.path, f]));
    const touched = (afterSnap.files || []).filter(f => {
      const prev = beforeMap.get(f.path);
      return !prev || prev.mtimeMs !== f.mtimeMs || prev.size !== f.size;
    });
    if (touched.length) {
      lines.push(`- 变更/新增文件列表（共 ${touched.length} 个）：\n` + touched.slice(0, 25).map(f => `  * ${f.path} (${f.size} bytes)`).join('\n'));
    }
  }

  return {
    beforeSnap,
    afterSnap,
    changed,
    evidenceText: lines.join('\n')
  };
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
              let permLine;
              if (binding.allowWrite) {
                if (Array.isArray(binding.ownedPaths) && binding.ownedPaths.length > 0) {
                  permLine = `本席位处于分片可写施工模式，仅允许修改分配给你负责的路径范围：[${binding.ownedPaths.join(', ')}]，严禁修改其他分片的文件（Windows 环境请使用 PowerShell 语法）。`;
                } else {
                  permLine = '本席位处于可写施工模式，可按任务要求读写工作区文件或执行验证命令（Windows 环境请使用 PowerShell 语法）。';
                }
              } else if (binding.role === 'review') {
                permLine = '本席位处于只读审验模式，拥有全仓源码只读查阅权限与只读 Shell 验证权限（可运行编译检查、测试或查询命令），但严禁修改、创建、删除工作区任何文件或改动 Git 状态。';
              } else {
                permLine = '本席位处于纯只读设计/规划/汇报模式，可通过只读文件工具（含 run_code 内的 tools.ops_glob / ops_grep / ops_read_files / ops_inspect_local_file）查阅源码，但严禁执行 Shell 命令（ops_bash 等），严禁修改、创建或删除工作区文件。';
              }
              const lines = [
                `你是内阁中的「${binding.seatLabel}」，当前担任职责：${binding.roleBadge}。`,
                permLine,
                '各席位之间的传话、阶段交接与任务板更新均由内阁编排器自动完成。请直接输出你的本阶段成果，严禁自行调用 list_agents、send_message、subagent、subagent_fork 或任务板工具去联系队友或派发任务。',
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

    if (typeof this.ctx.on === 'function') {
      try {
        const off = this.ctx.on('tools/pre-execute', async (exec, next) => {
          const sid = exec?.agent?.id;
          const binding = sid ? this.seatBindings.get(sid) : null;
          if (!binding) return typeof next === 'function' ? next() : undefined;
          const check = evaluateSeatToolExecution(binding, exec?.name, exec?.arguments ?? exec?.input ?? {});
          if (!check.allowed) {
            return {
              kind: 'deny',
              reason: check.reason,
              info: {
                name: 'CabinetPolicyError',
                code: check.code || 'CABINET_TOOL_DENIED'
              }
            };
          }
          return typeof next === 'function' ? next() : undefined;
        }, { prepend: true });
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

  resolveWorkspaceRoot(rootAgent) {
    return rootAgent?.workspace?.root
      || rootAgent?.workspaceRoot
      || rootAgent?.cwd
      || rootAgent?.session?.header?.cwd
      || process.cwd();
  }

  captureWorkspaceSnapshot(rootAgent) {
    return captureWorkspaceSnapshot(this.resolveWorkspaceRoot(rootAgent));
  }

  collectConstructionEvidence(rootAgent, beforeSnap) {
    return collectConstructionEvidence(this.resolveWorkspaceRoot(rootAgent), beforeSnap);
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
    ownedPaths = null,
    outputSchema = undefined,
    signal
  }) {
    const subagents = this.ctx?.get?.('subagents') ?? this.ctx?.subagents;
    if (!subagents) throw new Error('宿主未挂载官方 @deepseek-ai/dsh-subagent 服务');

    const runCall = async () => {
      signal?.throwIfAborted?.();
      const effort = model.reasoningEffort && model.reasoningEffort !== 'default' && model.reasoningEffort !== '默认'
        ? model.reasoningEffort
        : null;
      const agentOptions = {
        provider: model.providerId,
        model: model.modelId,
        ...(effort ? { reasoningEffort: effort } : {})
      };

      const bindingInfo = {
        role,
        roleBadge,
        seatLabel,
        providerId: model.providerId,
        modelId: model.modelId,
        allowWrite,
        ownedPaths: Array.isArray(ownedPaths) && ownedPaths.length ? ownedPaths : null,
        workspaceRoot: this.resolveWorkspaceRoot(rootAgent),
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
        this.seatBindings.set(activation.childId, bindingInfo);
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
