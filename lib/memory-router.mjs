import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROLES = new Set(['secretary', 'design', 'construction', 'review']);

export const DEFAULT_ROLE_EXPERIENCES = Object.freeze({
  secretary: {
    role: 'secretary',
    version: 'secretary-zh-v2',
    updatedAt: '2026-11-13T00:00:00.000Z',
    rules: [
      '先结论后论据：首句直接说明当前阶段进展或最终结论，随后简要列出关键成果与待办。',
      '使用自然、简明的中文汇报，禁止输出免责声明、自我辩护或内部协议字段名。',
      '完整保留各工作组与独立席的原始交付成果及裁决归属，不做截断、篡改或代用户确认验收。',
      '协作期间保持只读观察与旁路汇报，不阻断工作组正常交接；独自承担用户直接指派的小任务时按已授权能力直接执行。'
    ],
    entries: []
  },
  design: {
    role: 'design',
    version: 'design-zh-v2',
    updatedAt: '2026-11-13T00:00:00.000Z',
    rules: [
      '直奔核心业务目标，明确模块划分、接口契约、施工步骤与验收判据。',
      '严禁设计空壳脚手架、过度封装的包装器或无业务价值的防御性检查。'
    ],
    entries: []
  },
  construction: {
    role: 'construction',
    version: 'construction-zh-v2',
    updatedAt: '2026-11-13T00:00:00.000Z',
    rules: [
      '严格依据已通过审验的设计方案与施工顺序编写完整可用代码，不使用占位符。',
      '修改前核对工作区真实文件结构，完成后通过只读检查或命令验证实际产物。'
    ],
    entries: []
  },
  review: {
    role: 'review',
    version: 'review-zh-v2',
    updatedAt: '2026-11-13T00:00:00.000Z',
    rules: [
      '对照任务目标与设计标准逐项核查完整性、准确性及是否存在防御性冗余。',
      '给出明确的通过（pass）或退回修改（changes）结论；退回时逐条列出具体位置与修改要求。'
    ],
    entries: []
  }
});

const modelHash = (p, m) => crypto.createHash('sha256').update(`${p || 'unknown'}::${m || 'unknown'}`).digest('hex').slice(0, 32);

export class MemoryRouter {
  constructor(dataRoot) {
    this.dataRoot = path.resolve(dataRoot);
    this.roleRoot = path.join(this.dataRoot, 'role-experience');
    this.modelRoot = path.join(this.dataRoot, 'model-memory');
    this.externalProviders = { handbook: null, persona: null };
    this.ensureDefaults();
    globalThis.__dshCabinetMemoryRouter = this;
  }

  registerExternalProvider(kind, provider) {
    if (kind !== 'handbook' && kind !== 'persona') return () => {};
    this.externalProviders[kind] = provider;
    return () => {
      if (this.externalProviders[kind] === provider) {
        this.externalProviders[kind] = null;
      }
    };
  }

  unregisterExternalProvider(kind) {
    if (kind === 'handbook' || kind === 'persona') {
      this.externalProviders[kind] = null;
    }
  }

  ensureDefaults() {
    fs.mkdirSync(this.roleRoot, { recursive: true });
    fs.mkdirSync(this.modelRoot, { recursive: true });
    for (const [role, initial] of Object.entries(DEFAULT_ROLE_EXPERIENCES)) {
      const file = path.join(this.roleRoot, role, 'experience.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify(initial, null, 2) + '\n', 'utf8');
      } else if (role === 'secretary') {
        try {
          const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (existing.version === 'secretary-role-n2-v1' || !Array.isArray(existing.rules)) {
            const entries = (existing.entries ?? []).filter(e => typeof e?.text === 'string' && !e.text.startsWith('Only report'));
            fs.writeFileSync(file, JSON.stringify({ ...initial, entries }, null, 2) + '\n', 'utf8');
          }
        } catch {
          fs.writeFileSync(file, JSON.stringify(initial, null, 2) + '\n', 'utf8');
        }
      }
    }
  }

  readRoleExperience(role = 'secretary', projectId = null) {
    const r = ROLES.has(role) ? role : 'secretary';
    const file = path.join(this.roleRoot, r, 'experience.json');
    let data = DEFAULT_ROLE_EXPERIENCES[r];
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    const rules = Array.isArray(data.rules) ? data.rules : DEFAULT_ROLE_EXPERIENCES[r].rules;
    const entries = (data.entries ?? []).filter(e => !projectId || !e.projectId || e.projectId === projectId);
    return { role: r, version: data.version ?? `${r}-zh-v2`, rules, entries };
  }

  appendRoleExperience(role, entry) {
    const r = ROLES.has(role) ? role : 'secretary';
    const file = path.join(this.roleRoot, r, 'experience.json');
    const current = this.readRoleExperience(r);
    const summary = String(entry?.summary ?? entry?.text ?? '').trim();
    if (!summary) return current;
    const record = { id: entry.id ?? `exp-${Date.now().toString(36)}`, at: new Date().toISOString(), projectId: entry.projectId ?? null, summary };
    const next = { ...current, updatedAt: record.at, entries: [...current.entries.filter(e => e.summary !== summary).slice(-29), record] };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
    return next;
  }

  readModelMemory({ providerId, modelId }) {
    if (!providerId || !modelId) return { providerId: providerId ?? '', modelId: modelId ?? '', version: 'model-memory-v2', notes: [], entries: [] };
    const file = path.join(this.modelRoot, modelHash(providerId, modelId), 'memory.json');
    if (!fs.existsSync(file)) return { providerId, modelId, version: 'model-memory-v2', notes: [], entries: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if ((raw.provider && raw.provider !== providerId) || (raw.model && raw.model !== modelId)) {
        return { providerId, modelId, version: 'model-memory-v2', notes: [], entries: [] };
      }
      return { providerId, modelId, version: raw.version ?? 'model-memory-v2', notes: raw.notes ?? [], entries: raw.entries ?? [] };
    } catch {
      return { providerId, modelId, version: 'model-memory-v2', notes: [], entries: [] };
    }
  }

  appendModelMemory({ providerId, modelId }, noteText, source = 'task') {
    if (!providerId || !modelId || !noteText?.trim()) return null;
    const dir = path.join(this.modelRoot, modelHash(providerId, modelId));
    fs.mkdirSync(dir, { recursive: true });
    const current = this.readModelMemory({ providerId, modelId });
    const entry = { id: `mem-${Date.now().toString(36)}`, at: new Date().toISOString(), text: noteText.trim(), source };
    const next = { providerId, modelId, version: 'model-memory-v2', updatedAt: entry.at, notes: current.notes, entries: [...current.entries.filter(e => e.text !== entry.text).slice(-19), entry] };
    fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify(next, null, 2) + '\n', 'utf8');
    return next;
  }

  formatPromptContext({ role, providerId, modelId, projectId = null }) {
    const roleExp = this.readRoleExperience(role, projectId);
    const modelMem = this.readModelMemory({ providerId, modelId });
    const lines = [];
    if (roleExp.rules.length) {
      lines.push(`【${role}岗位准则】`);
      for (const r of roleExp.rules) lines.push(`- ${r}`);
    }

    let externalHandbookUsed = false;
    try {
      const extHb = this.externalProviders?.handbook;
      if (extHb && typeof extHb.getPromptBlockForCabinetRole === 'function') {
        const hbBlock = extHb.getPromptBlockForCabinetRole(role);
        if (hbBlock && typeof hbBlock === 'string' && hbBlock.trim()) {
          lines.push(hbBlock.trim());
          externalHandbookUsed = true;
        }
      }
    } catch {}

    if (!externalHandbookUsed && roleExp.entries.length) {
      lines.push(`【${role}岗位历史经验】`);
      for (const e of roleExp.entries.slice(-5)) lines.push(`- ${e.summary}`);
    }

    let externalPersonaUsed = false;
    try {
      const extPersona = this.externalProviders?.persona;
      if (extPersona && typeof extPersona.getPromptBlockForModel === 'function') {
        const pBlock = extPersona.getPromptBlockForModel({ providerId, modelId });
        if (pBlock && typeof pBlock === 'string' && pBlock.trim()) {
          lines.push(pBlock.trim());
          externalPersonaUsed = true;
        }
      }
    } catch {}

    const items = [...(modelMem.notes ?? []), ...(modelMem.entries ?? []).map(e => e.text ?? e.summary).filter(Boolean)];
    if (!externalPersonaUsed && items.length) {
      lines.push(`【本模型（${providerId}/${modelId}）专属记忆】`);
      for (const item of items.slice(-5)) lines.push(`- ${item}`);
    }
    return { roleExperience: roleExp, modelMemory: modelMem, promptBlock: lines.join('\n') };
  }
}
