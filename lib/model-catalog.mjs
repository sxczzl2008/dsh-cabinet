export function shortenModelName(modelId, displayName) {
  const raw = String(displayName || modelId || '').trim();
  if (!raw) return '模型';
  if (/claude-opus-4-6-thinking/i.test(raw)) return 'Claude 4.6T';
  if (/claude-opus-4\.6/i.test(raw)) return 'Claude 4.6';
  if (/claude-opus-5-5/i.test(raw)) return 'Claude 5.5';
  if (/claude-fable-5/i.test(raw)) return 'Claude Fable';
  if (/deepseek-v4-pro/i.test(raw)) return 'DeepSeek Pro';
  if (/deepseek-flash|v4\.1-flash/i.test(raw)) return 'DeepSeek Flash';
  if (/gemini/i.test(raw)) return 'Gemini 2.1';
  return raw.length > 18 ? raw.slice(0, 18) : raw;
}

export class ModelCatalogService {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.options = options;
    this.generation = 1;
    this.cachedCatalog = null;
    this.listeners = new Set();
    this.disposers = [];
  }

  subscribeEvents(onUpdate) {
    if (typeof onUpdate === 'function') this.listeners.add(onUpdate);
    const bump = () => {
      this.generation += 1;
      this.cachedCatalog = null;
      for (const fn of this.listeners) { try { fn(this.generation); } catch {} }
    };
    for (const evt of ['llm/adapters-updated', 'llm/models-updated', 'connection/reset']) {
      try {
        const off = this.ctx.on?.(evt, bump);
        if (typeof off === 'function') this.disposers.push(off);
      } catch {}
    }
  }

  async getCatalog({ forceRefresh = false } = {}) {
    if (this.cachedCatalog && !forceRefresh) return this.cachedCatalog;
    const groups = [], failures = [], flatModels = [];
    let llmSvc = null;
    try { llmSvc = this.ctx?.get?.('llm') ?? this.ctx?.llm; } catch { try { llmSvc = this.ctx?.get?.('llm'); } catch {} }
    const providers = llmSvc?.listProviders?.() ?? [];

    for (const provider of providers) {
      try {
        const rawModels = await llmSvc.listModels(provider.id);
        const entries = [];
        for (const m of rawModels) {
          let resolved = null;
          try { resolved = await this.ctx.llm.resolveModelInfo?.(provider.id, m.id); } catch {}
          const rObj = resolved?.reasoning ?? m.reasoning;
          const efforts = Array.isArray(rObj?.efforts) ? rObj.efforts.map(e => typeof e === 'string' ? e : e.id).filter(Boolean) : [];
          const defaultEffort = rObj?.defaultEffort ?? (efforts[0] || null);
          const contextWindow = resolved?.context?.contextWindow ?? m.contextWindow ?? 256000;
          const entry = {
            key: `${provider.id}::${m.id}`,
            providerId: provider.id,
            providerName: provider.name || provider.id,
            modelId: m.id,
            displayName: m.name || m.id,
            shortLabel: shortenModelName(m.id, m.name),
            reasoningEffortOptions: efforts,
            defaultEffort,
            contextWindow,
            capabilities: resolved?.inputModalities ?? m.inputModalities ?? ['text'],
            available: true
          };
          entries.push(entry);
          flatModels.push(entry);
        }
        if (entries.length) groups.push({ providerId: provider.id, providerName: provider.name || provider.id, models: entries });
      } catch (err) {
        failures.push({ providerId: provider.id, providerName: provider.name || provider.id, message: err instanceof Error ? err.message : String(err) });
      }
    }

    this.cachedCatalog = { generation: this.generation, updatedAt: new Date().toISOString(), groups, models: flatModels, failures };
    return this.cachedCatalog;
  }

  async resolveModelRef(modelRef) {
    if (!modelRef) return null;
    const catalog = await this.getCatalog();
    if (typeof modelRef === 'object') {
      const pid = modelRef.providerId ?? modelRef.provider;
      const mid = modelRef.modelId ?? modelRef.model;
      if (!pid || !mid) return null;
      const found = catalog.models.find(m => m.providerId === pid && m.modelId === mid)
        ?? catalog.models.find(m => m.modelId === mid);
      if (found) return { ...found, reasoningEffort: modelRef.reasoningEffort ?? found.defaultEffort ?? null };
      return {
        key: `${pid}::${mid}`,
        providerId: pid,
        providerName: modelRef.providerName ?? pid,
        modelId: mid,
        displayName: modelRef.displayName ?? modelRef.label ?? mid,
        shortLabel: shortenModelName(mid, modelRef.displayName ?? modelRef.label),
        reasoningEffort: modelRef.reasoningEffort ?? null,
        reasoningEffortOptions: modelRef.reasoningEffortOptions ?? [],
        contextWindow: modelRef.contextWindow ?? 245000,
        available: true
      };
    }
    const str = String(modelRef);
    if (str.includes('::')) {
      const [providerId, modelId] = str.split('::');
      return this.resolveModelRef({ providerId, modelId });
    }
    const byId = catalog.models.find(m => m.modelId === str || m.key === str);
    return byId ? { ...byId, reasoningEffort: byId.defaultEffort ?? null } : null;
  }

  dispose() {
    while (this.disposers.length) { try { this.disposers.pop()(); } catch {} }
  }
}

