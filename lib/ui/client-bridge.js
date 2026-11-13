(function installCabinetV2Bridge() {
  if (globalThis.__dshCabinetV2 && globalThis.__dshCabinetV2.__cleanV2) return;
  const states = new Map();
  const listeners = new Set();
  const endpoint = '/cabinet-v2';
  let catalogCache = null;
  let stream = null;
  let streamId = null;

  function publish(snapshot) {
    if (!snapshot || !snapshot.sessionId) return;
    if (snapshot.catalog) catalogCache = snapshot.catalog;
    states.set(snapshot.sessionId, snapshot);
    for (const fn of listeners) {
      try { fn(snapshot); } catch {}
    }
    globalThis.dispatchEvent(new CustomEvent('dsh-cabinet-v2-state', { detail: snapshot }));
  }

  function connect(sessionId) {
    if (typeof EventSource !== 'function' || !sessionId) return;
    if (streamId === sessionId && stream) return;
    try { stream?.close(); } catch {}
    streamId = sessionId;
    const current = new EventSource(`${endpoint}/events?sessionId=${encodeURIComponent(sessionId)}`);
    stream = current;
    current.onmessage = event => {
      if (stream !== current) return;
      try {
        const data = JSON.parse(event.data);
        if (data?.snapshot) publish(data.snapshot);
      } catch {}
    };
  }

  async function request(body, query) {
    const url = body ? endpoint : `${endpoint}?${new URLSearchParams(query)}`;
    const res = await fetch(url, body ? {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    } : { credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok || data?.ok === false) {
      throw Object.assign(new Error(data?.error || `请求未完成 (${res.status})`), {
        code: data?.code,
        errors: data?.errors
      });
    }
    if (data?.catalog) catalogCache = data.catalog;
    if (data?.snapshot) publish(data.snapshot);
    return data;
  }

  const bridge = {
    __cleanV2: true,
    snapshot: id => states.get(id) ?? {
      sessionId: id,
      mode: 'ordinary',
      configVersion: 0,
      config: null,
      catalog: catalogCache,
      collaboration: null,
      sourceSeq: 0
    },
    catalog: () => catalogCache,
    subscribe: fn => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    refresh: async id => {
      if (!id) return null;
      connect(id);
      const data = await request(null, { action: 'snapshot', sessionId: id });
      return data.snapshot;
    },
    getCatalog: async (force = false) => {
      const data = await request(null, { action: 'catalog', ...(force ? { refresh: '1' } : {}) });
      return data.catalog;
    },
    getPlan: async () => {
      const data = await request(null, { action: 'getPlan' });
      return data;
    },
    savePlan: (plan, expectedRevision) => request({ action: 'savePlan', config: plan, expectedVersion: expectedRevision }),
    applyTask: (sessionId, task, expectedVersion) => request({ action: 'applyTask', sessionId, config: task, expectedVersion }),
    groupCommand: async (sessionId, command) => {
      const data = await request({ action: 'groupCommand', sessionId, command: { commandId: `cmd-${Date.now().toString(36)}`, ...command } });
      return data;
    },
    readGroupConversation: (sessionId, groupId) => request(null, { action: 'readGroupConversation', sessionId, groupId }),
    readGroupOriginal: (sessionId, groupId, sourceId) => request(null, { action: 'readGroupOriginal', sessionId, groupId: groupId || 'main', sourceId })
  };

  globalThis.__dshCabinetV2 = bridge;
  globalThis.dispatchEvent(new Event('dsh-cabinet-v2-ready'));
})();
