/**
 * dsh-cabinet — client bundle.
 * Registers the root-level "内阁模式" section in Settings left rail (matching Windows-MCP style)
 * and the bundle card in Settings -> Plugins.
 */
window.__ModuleLoader__.load({
  id: "dsh-cabinet",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var react = React;
    var react_dom = require("react-dom");
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
    const prior = states.get(snapshot.sessionId);
    if (Number.isSafeInteger(prior?.configVersion) && Number.isSafeInteger(snapshot.configVersion)
      && snapshot.configVersion < prior.configVersion) return;
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
      return states.get(id) || data.snapshot;
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
    applyTask: (sessionId, task, expectedVersion) => request({ action: 'applyTask', sessionId, config: task, expectedVersion, entryChoice: 'new' }),
    detachConfiguration: (sessionId, taskId, expectedVersion) => request({ action: 'detachConfiguration', sessionId, taskId, expectedVersion }),
    taskHistory: async sessionId => (await request(null, { action: 'taskHistory', sessionId })).tasks,
    completedTasks: sessionId => request(null, { action: 'completedTasks', ...(sessionId ? { sessionId } : {}) }),
    deleteTask: (sessionId, taskId, expectedVersion) => request({ action: 'deleteTask', sessionId, taskId, expectedVersion, confirmPermanent: true }),
    clearDeletedTaskCaches: () => request({ action: 'clearDeletedTaskCaches', confirmPermanent: true }),
    resumePreview: async sessionId => (await request(null, { action: 'resumePreview', sessionId })).preview,
    resumeCheckpoint: (sessionId, preview, secretaryModel) => request({ action: 'resumeCheckpoint', sessionId, checkpointId: preview.checkpointId, taskId: preview.taskId, entryChoice: 'resume', ...(secretaryModel ? { secretaryModel } : {}) }),
    groupCommand: async (sessionId, command) => {
      const state = states.get(sessionId);
      const data = await request({ action: 'groupCommand', sessionId, command: { commandId: `cmd-${Date.now().toString(36)}`, taskId: state?.nativeGroup?.taskId || state?.config?.taskId, ...command } });
      return data;
    },
    readGroupConversation: (sessionId, groupId) => request(null, { action: 'readGroupConversation', sessionId, groupId }),
    readGroupOriginal: (sessionId, groupId, sourceId) => request(null, { action: 'readGroupOriginal', sessionId, groupId: groupId || 'main', sourceId })
  };

  globalThis.__dshCabinetV2 = bridge;
  globalThis.dispatchEvent(new Event('dsh-cabinet-v2-ready'));
})();

const cabinetV2H = (...args) => react.createElement(...args);
const cabinetV2Clone = value => JSON.parse(JSON.stringify(value));

const CABINET_ROLES = [
  { id: 'design', label: '设计席', groupLabel: '设计组' },
  { id: 'construction', label: '施工席', groupLabel: '施工组' },
  { id: 'review', label: '审验席', groupLabel: '审验组' }
];

const CABINET_KINDS = [
  { id: 'leader', label: '组长' },
  { id: 'member', label: '组员' },
  { id: 'independent', label: '独立' }
];

const ROLE_NAME_MAP = { design: '设计', construction: '施工', review: '审验' };
const KIND_NAME_MAP = { leader: '组长', member: '组员', independent: '独立' };

function cabinetV2Errors(error) {
  const rows = error?.errors ?? error?.details?.errors;
  if (Array.isArray(rows) && rows.length) return rows.map(r => r.message || r.code || '配置不完整');
  if (typeof error?.error === 'string') return [error.error];
  return [String(error?.message ?? error ?? '操作未完成')];
}

function shortenLabel(modelId, displayName) {
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

function normalizeDraftConfig(raw = {}) {
  const seats = Array.isArray(raw.seats) ? cabinetV2Clone(raw.seats).filter(s => s && s.model?.modelId) : [];
  const staging = Array.isArray(raw.staging) ? cabinetV2Clone(raw.staging).filter(s => s && s.model?.modelId) : [];
  const hasSecModel = Boolean(raw.secretary?.model?.modelId || raw.secretary?.model?.model);
  const secretary = hasSecModel
    ? {
        id: 'secretary',
        label: raw.secretary.label || shortenLabel(raw.secretary.model.modelId ?? raw.secretary.model.model, raw.secretary.model.displayName),
        model: cabinetV2Clone(raw.secretary.model)
      }
    : { id: 'secretary', label: '秘书席', model: null };

  const maxSeatIdx = seats.reduce((m, s) => Math.max(m, (s.seatIndex ?? 0) + 1), 0);
  const rawSlots = Number.isInteger(raw.slotCount) ? raw.slotCount : Math.max(3, maxSeatIdx);
  const slotCount = Math.min(9, Math.max(1, rawSlots, maxSeatIdx));

  const policies = {
    handoff: raw.policies?.handoff || 'wait',
    humanApprovalRequired: raw.policies?.humanApprovalRequired === true,
    memberPool: raw.policies?.memberPool?.scope ? raw.policies.memberPool : { scope: 'group', seatIds: [] }
  };
  return {
    ...raw,
    schemaVersion: 2,
    slotCount,
    discussionRounds: raw.discussionRounds === undefined ? 3 : raw.discussionRounds,
    seats,
    staging,
    secretary,
    policies,
    participants: seats.filter(s => s.inSeat !== false && (s.duties?.length ?? 0) > 0).map(s => s.id)
  };
}

function findCurrentLeader(draft, role, groupId = `${role}-group`) {
  const all = [...(draft.seats ?? []), ...(draft.staging ?? [])];
  for (const card of all) {
    for (const d of card.duties ?? []) {
      if (d.role === role && d.kind === 'leader' && (d.groupId || `${role}-group`) === groupId) {
        return card;
      }
    }
  }
  return null;
}

function computeInstanceLabel(draft, providerId, modelId, shortLabel) {
  const all = [
    ...(draft.seats ?? []),
    ...(draft.staging ?? []),
    ...(draft.secretary?.model ? [{ model: draft.secretary.model }] : [])
  ];
  const sameCount = all.filter(c => c.model?.providerId === providerId && c.model?.modelId === modelId).length;
  return sameCount === 0 ? `${shortLabel} · 1` : `${shortLabel} · ${sameCount + 1}`;
}

function CabinetV2ConfigEditor({ value, onChange, disabled = false, context = 'task' }) {
  const H = cabinetV2H;
  const bridge = globalThis.__dshCabinetV2;
  const draft = normalizeDraftConfig(value);

  const [catalog, setCatalog] = react.useState(() => bridge?.catalog?.() ?? null);
  const [selectedChip, setSelectedChip] = react.useState(null);
  const [focusedRole, setFocusedRole] = react.useState(null);
  const [hintText, setHintText] = react.useState('');
  const [showHelp, setShowHelp] = react.useState(false);
  const [showGoalEditor, setShowGoalEditor] = react.useState(false);
  const [showDesignPicker, setShowDesignPicker] = react.useState(false);

  react.useEffect(() => {
    let active = true;
    bridge?.getCatalog?.().then(cat => { if (active && cat) setCatalog(cat); }).catch(() => {});
    return () => { active = false; };
  }, [bridge]);

  const update = fn => {
    const next = normalizeDraftConfig(draft);
    fn(next);
    next.participants = next.seats.filter(s => s.inSeat !== false && (s.duties?.length ?? 0) > 0).map(s => s.id);
    onChange(next);
  };

  const catalogGroups = catalog?.groups ?? [];
  const allCatalogModels = catalog?.models ?? [];

  const handleAddModelFromDropdown = e => {
    const key = e.target.value;
    if (!key) return;
    const found = allCatalogModels.find(m => m.key === key);
    if (!found) return;
    update(next => {
      const label = computeInstanceLabel(next, found.providerId, found.modelId, found.shortLabel);
      next.staging.push({
        id: `part-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
        label,
        model: {
          providerId: found.providerId,
          providerName: found.providerName,
          modelId: found.modelId,
          displayName: found.displayName,
          shortLabel: found.shortLabel,
          reasoningEffort: found.defaultEffort ?? null,
          reasoningEffortOptions: found.reasoningEffortOptions ?? []
        },
        duties: []
      });
    });
    setHintText('');
  };

  const placeModelInSlot = (cardId, fromZone, targetSlotIndex) => {
    update(next => {
      const existingAtSlot = next.seats.find(s => s.seatIndex === targetSlotIndex && s.inSeat !== false);
      if (existingAtSlot && existingAtSlot.id !== cardId) return;
      let card = null;
      if (fromZone === 'staging') {
        const idx = next.staging.findIndex(c => c.id === cardId);
        if (idx >= 0) card = next.staging.splice(idx, 1)[0];
      } else if (fromZone === 'seat') {
        card = next.seats.find(s => s.id === cardId);
      } else if (fromZone === 'secretary' && next.secretary?.model) {
        card = {
          id: `part-${Date.now().toString(36)}`,
          label: next.secretary.label || next.secretary.model.shortLabel,
          model: next.secretary.model,
          duties: []
        };
        next.secretary = { id: 'secretary', label: '秘书席', model: null };
      }
      if (!card) return;
      card.seatIndex = targetSlotIndex;
      card.inSeat = true;
      if (!next.seats.some(s => s.id === card.id)) next.seats.push(card);
    });
    setSelectedChip(null);
    setHintText('');
  };

  const moveSeatToStaging = (cardId, fromZone = 'seat') => {
    update(next => {
      if (fromZone === 'secretary') {
        if (next.secretary?.model) {
          next.staging.push({
            id: `part-${Date.now().toString(36)}`,
            label: next.secretary.label || next.secretary.model.shortLabel,
            model: next.secretary.model,
            duties: []
          });
          next.secretary = { id: 'secretary', label: '秘书席', model: null };
        }
        return;
      }
      const idx = next.seats.findIndex(s => s.id === cardId);
      if (idx >= 0) {
        const card = next.seats.splice(idx, 1)[0];
        card.inSeat = false;
        next.staging.push(card);
      }
    });
    setSelectedChip(null);
  };

  const assignSecretaryModel = (cardId, fromZone) => {
    update(next => {
      let card = null;
      if (fromZone === 'staging') {
        const idx = next.staging.findIndex(c => c.id === cardId);
        if (idx >= 0) card = next.staging.splice(idx, 1)[0];
      } else if (fromZone === 'seat') {
        const idx = next.seats.findIndex(s => s.id === cardId);
        if (idx >= 0) card = next.seats.splice(idx, 1)[0];
      }
      if (!card) return;
      if (next.secretary?.model) {
        next.staging.push({
          id: `part-${Date.now().toString(36)}`,
          label: next.secretary.label || next.secretary.model.shortLabel,
          model: next.secretary.model,
          duties: []
        });
      }
      next.secretary = {
        id: 'secretary',
        model: card.model,
        label: card.label || card.model.shortLabel
      };
    });
    setSelectedChip(null);
    setHintText('');
  };

  const clearSecretaryModel = () => {
    update(next => {
      if (next.secretary?.model) {
        next.staging.push({
          id: `part-${Date.now().toString(36)}`,
          label: next.secretary.label || next.secretary.model.shortLabel,
          model: next.secretary.model,
          duties: []
        });
      }
      next.secretary = { id: 'secretary', label: '秘书席', model: null };
    });
    setSelectedChip(null);
  };

  const addWorkSlot = () => {
    update(next => {
      next.slotCount = Math.min(9, (next.slotCount || 3) + 1);
    });
  };

  const removeWorkSlot = () => {
    update(next => {
      const currentSlots = next.slotCount || 3;
      if (currentSlots <= 1) return;
      const targetSlotIdx = currentSlots - 1;
      const seatIdx = next.seats.findIndex(s => s.seatIndex === targetSlotIdx && s.inSeat !== false);
      if (seatIdx >= 0) {
        const removed = next.seats.splice(seatIdx, 1)[0];
        removed.inSeat = false;
        next.staging.push(removed);
      }
      next.slotCount = currentSlots - 1;
    });
  };

  const addRoleToSeat = (seatId, roleId) => {
    update(next => {
      const seat = next.seats.find(s => s.id === seatId);
      if (!seat) return;
      seat.duties ??= [];
      if (!seat.duties.some(d => d.role === roleId)) {
        seat.duties.push({
          role: roleId,
          kind: 'independent',
          ...(roleId === 'review' ? { reviewTargets: ['design', 'construction'] } : {})
        });
      }
    });
    setSelectedChip(null);
    setHintText('');
  };

  const assignKindToDuty = (seatId, roleId, kindId) => {
    if (kindId === 'leader') {
      const currentLeader = findCurrentLeader(draft, roleId, `${roleId}-group`);
      if (currentLeader && currentLeader.id !== seatId) {
        setHintText(`先移除 ${currentLeader.label} 的${ROLE_NAME_MAP[roleId]}组长标签。`);
        return;
      }
    }
    update(next => {
      const seat = next.seats.find(s => s.id === seatId);
      if (!seat) return;
      let duty = (seat.duties ?? []).find(d => d.role === roleId);
      if (!duty && (seat.duties ?? []).length === 1) duty = seat.duties[0];
      if (!duty) return;
      duty.kind = kindId;
      if (kindId === 'independent') {
        delete duty.groupId;
        delete duty.groupName;
      } else {
        duty.groupId = `${duty.role}-group`;
        duty.groupName = `${ROLE_NAME_MAP[duty.role]}组`;
      }
    });
    setSelectedChip(null);
    setHintText('');
  };

  const removeDutyOrKind = (seatId, roleId, onlyKind = false) => {
    update(next => {
      const seat = next.seats.find(s => s.id === seatId);
      if (!seat) return;
      if (onlyKind) {
        const duty = (seat.duties ?? []).find(d => d.role === roleId);
        if (duty) {
          duty.kind = 'independent';
          delete duty.groupId;
          delete duty.groupName;
        }
      } else {
        seat.duties = (seat.duties ?? []).filter(d => d.role !== roleId);
      }
    });
    setHintText('');
  };

  const cycleReasoningEffort = card => {
    const isSecretary = card === 'secretary';
    const targetModel = isSecretary ? draft.secretary?.model : card.model;
    const opts = targetModel?.reasoningEffortOptions ?? [];
    if (!opts.length) return;
    const curIdx = opts.indexOf(targetModel.reasoningEffort);
    const nextEffort = opts[(curIdx + 1) % opts.length];
    update(next => {
      if (isSecretary) {
        if (next.secretary?.model) next.secretary.model.reasoningEffort = nextEffort;
        return;
      }
      const target = [...next.seats, ...next.staging].find(c => c.id === card.id);
      if (target?.model) target.model.reasoningEffort = nextEffort;
    });
  };

  const seatedCards = draft.seats.filter(s => s.inSeat !== false);
  const slotCount = Math.min(9, Math.max(1, draft.slotCount || 3));
  const hasAnySeated = seatedCards.length > 0;

  const focusedSummary = (() => {
    const r = focusedRole || 'design';
    const members = seatedCards.filter(s => (s.duties ?? []).some(d => d.role === r && d.kind !== 'independent'));
    const leader = findCurrentLeader(draft, r, `${r}-group`);
    if (members.length >= 2 && leader) return `${ROLE_NAME_MAP[r]}组 · ${leader.label} 负责 · ${members.length} 人`;
    return `工作席 ${seatedCards.length} / 9`;
  })();

  const handleDropData = (e, onPayload) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const raw = e.dataTransfer.getData('application/x-cabinet-chip') || e.dataTransfer.getData('text/plain');
      if (raw) onPayload(JSON.parse(raw));
    } catch {}
  };

  const setDragData = (e, payload) => {
    const str = JSON.stringify(payload);
    try {
      e.dataTransfer.setData('application/x-cabinet-chip', str);
      e.dataTransfer.setData('text/plain', str);
      e.dataTransfer.effectAllowed = 'move';
    } catch {}
  };

  return H('div', {
    className: 'cabinet-v2-canvas',
    'data-cabinet-v2-editor': context,
    onKeyDown: e => { if (e.key === 'Escape') setSelectedChip(null); },
    style: {
      boxSizing: 'border-box', width: '100%', minWidth: 0,
      padding: 18, borderRadius: 14, background: 'var(--dsw-alias-bg-base, #fff)',
      border: '1px solid var(--dsw-alias-border-l2, #d9dfe5)', color: 'var(--dsw-alias-label-primary, #26313d)',
      display: 'flex', flexDirection: 'column', gap: 14, fontSize: 14
    }
  },
    H('style', null, `
      .cabinet-v2-modal-backdrop {
        position: fixed; inset: 0; z-index: 9999;
        background: rgba(15, 23, 42, 0.45);
        display: flex; align-items: center; justify-content: center;
        padding: 16px; box-sizing: border-box;
      }
      .cabinet-v2-modal-shell {
        box-sizing: border-box;
        width: clamp(320px, 92vw, 1260px);
        max-width: calc(100vw - 24px);
        max-height: calc(100vh - 24px);
        display: flex; flex-direction: column;
        border-radius: 16px;
        background: var(--dsw-alias-bg-base, #ffffff);
        color: var(--dsw-alias-label-primary, #26313d);
        border: 1px solid var(--dsw-alias-border-l2, #cdd8e5);
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.22);
        overflow: hidden;
      }
      .cabinet-v2-modal-body {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        overflow-x: auto;
        padding: 16px 20px;
        box-sizing: border-box;
      }
      .cabinet-v2-modal-body::-webkit-scrollbar { width: 8px; height: 8px; }
      .cabinet-v2-modal-body::-webkit-scrollbar-thumb { background: rgba(101, 113, 125, 0.35); border-radius: 4px; }
      .cabinet-v2-main-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 220px;
        gap: 16px;
        align-items: start;
        width: 100%;
        box-sizing: border-box;
      }
      .cabinet-v2-seats-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 12px;
        min-width: 0;
      }
      @media (max-width: 860px) {
        .cabinet-v2-main-grid {
          grid-template-columns: minmax(0, 1fr);
        }
      }
    `),
    renderCanvasHeader({ H, context, draft, update, disabled, showGoalEditor, setShowGoalEditor, showDesignPicker, setShowDesignPicker, showHelp, setShowHelp, selectedChip, setSelectedChip, setDragData, handleDropData, moveSeatToStaging, removeDutyOrKind, handleAddModelFromDropdown, catalogGroups }),
    renderCanvasBody({ H, draft, update, disabled, showHelp, showGoalEditor, showDesignPicker, hasAnySeated, focusedRole, setFocusedRole, selectedChip, setSelectedChip, setDragData, handleDropData, focusedSummary, seatedCards, slotCount, addWorkSlot, removeWorkSlot, clearSecretaryModel, placeModelInSlot, moveSeatToStaging, assignSecretaryModel, addRoleToSeat, assignKindToDuty, removeDutyOrKind, cycleReasoningEffort, hintText })
  );
}

function renderCanvasHeader({ H, context, draft, update, disabled, showGoalEditor, setShowGoalEditor, showDesignPicker, setShowDesignPicker, showHelp, setShowHelp, selectedChip, setSelectedChip, setDragData, handleDropData, moveSeatToStaging, removeDutyOrKind, handleAddModelFromDropdown, catalogGroups }) {
  return H('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' } },
    H('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
      H('strong', { style: { fontSize: 18 } }, context === 'task' ? '本任务设置' : '内阁常用方案'),
      H('span', { style: { fontSize: 13, color: '#65717d' } }, '设计 → 设计审验 → 施工 → 施工审验 → 交付'),
      context === 'task' && H('div', { style: { display: 'flex', gap: 12, alignItems: 'center', marginTop: 4, fontSize: 13, flexWrap: 'wrap' } },
        H('span', { style: { color: '#65717d' } }, draft.goal ? `任务：${draft.goal.slice(0, 32)}` : '任务说明'),
        H('button', { type: 'button', onClick: () => setShowGoalEditor(!showGoalEditor), style: { background: 'none', border: 0, color: '#3d609a', cursor: 'pointer', padding: 0, fontSize: 13 } }, '修改'),
        H('button', { type: 'button', onClick: () => setShowDesignPicker(!showDesignPicker), style: { background: 'none', border: 0, color: '#3d609a', cursor: 'pointer', padding: 0, fontSize: 13 } }, '现成设计'),
        H('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', color: '#65717d' } },
          H('input', {
            type: 'checkbox',
            checked: draft.policies?.humanApprovalRequired === true,
            onChange: e => update(next => { next.policies.humanApprovalRequired = e.target.checked; })
          }),
          '施工前需本人确认'
        )
      )
    ),

    H('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 } },
      H('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#65717d' } },
        H('span', null, '讨论轮数'),
        H('input', {
          type: 'range', min: 1, max: 5, step: 1, value: draft.discussionRounds, disabled,
          'aria-label': '讨论轮数', 'data-cabinet-discussion-rounds': '',
          onChange: e => {
            const rounds = Number(e.target.value);
            if (Number.isInteger(rounds) && rounds >= 1 && rounds <= 5) update(next => { next.discussionRounds = rounds; });
          },
          style: { width: 110, accentColor: '#3d609a' }
        }),
        H('output', { 'aria-live': 'polite', style: { minWidth: 12, color: '#3d609a', fontVariantNumeric: 'tabular-nums' } }, String(draft.discussionRounds))
      ),
      H('div', {
        'data-cabinet-staging-zone': '',
        onDragOver: e => e.preventDefault(),
        onDrop: e => handleDropData(e, p => {
          if (p.type === 'model' && (p.from === 'seat' || p.from === 'secretary')) moveSeatToStaging(p.cardId, p.from);
          else if (p.type === 'duty-tag') removeDutyOrKind(p.seatId, p.role, false);
          else if (p.type === 'kind-tag') removeDutyOrKind(p.seatId, p.role, true);
        }),
        onClick: () => {
          if (selectedChip?.type === 'model' && (selectedChip.from === 'seat' || selectedChip.from === 'secretary')) {
            moveSeatToStaging(selectedChip.cardId, selectedChip.from);
          }
        },
        style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minHeight: 38, padding: '4px 10px', borderRadius: 20, border: '1px dashed #c8d0d9', background: '#fafbfd' }
      },
        H('span', { style: { fontSize: 12, color: '#65717d' } }, '待放区'),
        (draft.staging ?? []).map(card => H('div', {
          key: card.id,
          draggable: !disabled,
          onDragStart: e => setDragData(e, { type: 'model', from: 'staging', cardId: card.id }),
          onClick: e => { e.stopPropagation(); setSelectedChip({ type: 'model', from: 'staging', cardId: card.id }); },
          title: `${card.model?.providerName || card.model?.providerId} / ${card.model?.displayName || card.model?.modelId}`,
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 18,
            background: selectedChip?.cardId === card.id ? '#edf3fd' : '#f1f4f7',
            border: selectedChip?.cardId === card.id ? '1px solid #91acd5' : '1px solid #d7dee6',
            cursor: 'grab', fontSize: 13
          }
        },
          H('span', null, card.label),
          H('button', {
            type: 'button',
            onClick: e => { e.stopPropagation(); update(next => { next.staging = next.staging.filter(c => c.id !== card.id); }); },
            style: { background: 'none', border: 0, cursor: 'pointer', color: '#65717d', padding: 0, fontSize: 13 }
          }, '×')
        ))
      ),

      H('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        H('select', {
          'aria-label': '选择模型',
          value: '',
          disabled,
          onChange: handleAddModelFromDropdown,
          style: { padding: '7px 12px', borderRadius: 8, border: '1px solid #d7dee6', background: 'var(--dsw-alias-bg-base, #fff)', color: 'inherit', fontSize: 14, minWidth: 220 }
        },
          H('option', { value: '' }, '选择模型 ▾'),
          catalogGroups.map(group => H('optgroup', { key: group.providerId, label: group.providerName },
            group.models.map(m => H('option', { key: m.key, value: m.key }, `${m.shortLabel} (${m.displayName})`))
          ))
        ),
        H('button', {
          type: 'button', 'aria-label': '操作说明', onClick: () => setShowHelp(!showHelp),
          style: { width: 24, height: 24, borderRadius: '50%', border: '1px solid #d7dee6', background: '#edf0f3', color: '#65717d', cursor: 'pointer', fontSize: 13, padding: 0 }
        }, '?')
      )
    )
  );
}

function renderCanvasBody({ H, draft, update, disabled, showHelp, showGoalEditor, showDesignPicker, hasAnySeated, focusedRole, setFocusedRole, selectedChip, setSelectedChip, setDragData, handleDropData, focusedSummary, seatedCards, slotCount, addWorkSlot, removeWorkSlot, clearSecretaryModel, placeModelInSlot, moveSeatToStaging, assignSecretaryModel, addRoleToSeat, assignKindToDuty, removeDutyOrKind, cycleReasoningEffort, hintText }) {
  return H(react.Fragment, null,
    showHelp && H('div', {
      style: { padding: '10px 14px', borderRadius: 10, background: '#f5f7fa', border: '1px solid #d7dee6', fontSize: 13, lineHeight: 1.6, color: '#26313d' }
    },
      '1. 从右上角「选择模型」点选模型，上方待放区会生成模型气泡，按住拖入下方空工作席或秘书位（也可先点气泡再点席位）。',
      H('br'),
      '2. 模型入席后，将上方「设计席 / 施工席 / 审验席」拖进模型卡片，再将「组长 / 组员 / 独立」拖到对应职务标签上。',
      H('br'),
      '3. 每个工作组最多 1 位组长；更换组长前，先将原组长标签拖到卡片外移除。'
    ),

    showGoalEditor && H('div', { style: { display: 'grid', gap: 8, padding: 12, borderRadius: 10, background: '#fafbfd', border: '1px solid #d7dee6' } },
      H('input', {
        type: 'text', placeholder: '输入或修改本任务目标说明…', value: draft.goal || '',
        onChange: e => update(next => { next.goal = e.target.value; }),
        style: { padding: '7px 10px', borderRadius: 6, border: '1px solid #d7dee6', font: 'inherit' }
      })
    ),

    showDesignPicker && H('div', { style: { display: 'grid', gap: 8, padding: 12, borderRadius: 10, background: '#fafbfd', border: '1px solid #d7dee6' } },
      H('textarea', {
        rows: 3, placeholder: '无单独设计席时，可在此粘贴或关联现成设计方案内容…',
        value: draft.existingDesign?.text || '',
        onChange: e => update(next => { next.existingDesign = e.target.value ? { version: 'v1', text: e.target.value, approved: true } : null; }),
        style: { padding: '7px 10px', borderRadius: 6, border: '1px solid #d7dee6', font: 'inherit' }
      })
    ),

    hasAnySeated && H('div', {
      'data-cabinet-duty-pool': '',
      style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 0', borderTop: '1px solid #e9edf1', borderBottom: '1px solid #e9edf1' }
    },
      H('span', { style: { fontSize: 13, color: '#65717d' } }, '职务'),
      CABINET_ROLES.map(r => {
        const active = focusedRole === r.id || selectedChip?.role === r.id;
        return H('div', {
          key: r.id,
          draggable: !disabled,
          onDragStart: e => setDragData(e, { type: 'role', role: r.id }),
          onClick: () => {
            setFocusedRole(focusedRole === r.id ? null : r.id);
            setSelectedChip({ type: 'role', role: r.id });
          },
          style: {
            padding: '5px 14px', borderRadius: 18, fontSize: 13, cursor: 'grab',
            background: active ? '#edf3fd' : '#f1f4f7',
            border: active ? '1px solid #91acd5' : '1px solid #d7dee6',
            color: active ? '#3d609a' : '#26313d'
          }
        }, r.label);
      }),
      H('span', { style: { fontSize: 13, color: '#65717d', marginLeft: 12 } }, '身份'),
      CABINET_KINDS.map(k => {
        const active = selectedChip?.kind === k.id;
        return H('div', {
          key: k.id,
          draggable: !disabled,
          onDragStart: e => setDragData(e, { type: 'kind', kind: k.id }),
          onClick: () => setSelectedChip({ type: 'kind', kind: k.id }),
          style: {
            padding: '5px 14px', borderRadius: 18, fontSize: 13, cursor: 'grab',
            background: active ? '#edf3fd' : '#f1f4f7',
            border: active ? '1px solid #91acd5' : '1px solid #d7dee6',
            color: active ? '#3d609a' : '#26313d'
          }
        }, k.label);
      }),
      H('div', {
        'data-cabinet-remove-tag-zone': '',
        onDragOver: e => e.preventDefault(),
        onDrop: e => handleDropData(e, p => {
          if (p.type === 'duty-tag') removeDutyOrKind(p.seatId, p.role, false);
          else if (p.type === 'kind-tag') removeDutyOrKind(p.seatId, p.role, true);
        }),
        style: { marginLeft: 'auto', padding: '4px 12px', borderRadius: 14, border: '1px dashed #c8d0d9', fontSize: 12, color: '#65717d' }
      }, '拖到此处移除标签')
    ),

    hintText && H('div', { role: 'alert', style: { padding: '8px 12px', borderRadius: 8, background: '#fdf2f2', border: '1px solid #e6b8b8', color: '#be6262', fontSize: 13 } }, hintText),

    H('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 } },
      H('span', { style: { color: '#3d609a', fontWeight: 500 } }, focusedSummary),
      H('span', { style: { color: '#65717d' } }, `工作席 ${seatedCards.length} / ${slotCount}（上限 9 席）`)
    ),
    renderSeatsAndSecretary({ H, draft, update, disabled, slotCount, addWorkSlot, removeWorkSlot, clearSecretaryModel, seatedCards, focusedRole, selectedChip, setSelectedChip, setDragData, handleDropData, placeModelInSlot, assignSecretaryModel, addRoleToSeat, assignKindToDuty, removeDutyOrKind, cycleReasoningEffort })
  );
}

function renderSeatsAndSecretary({ H, draft, update, disabled, slotCount, addWorkSlot, removeWorkSlot, clearSecretaryModel, seatedCards, focusedRole, selectedChip, setSelectedChip, setDragData, handleDropData, placeModelInSlot, assignSecretaryModel, addRoleToSeat, assignKindToDuty, removeDutyOrKind, cycleReasoningEffort }) {
  const slots = Array.from({ length: slotCount }, (_, idx) => seatedCards.find(s => (s.seatIndex ?? 0) === idx) ?? null);
  const canRemoveSlot = slotCount > 1;
  const canAddSlot = slotCount < 9;

  return H('div', { className: 'cabinet-v2-main-grid' },
    H('div', { className: 'cabinet-v2-seats-grid' },
      slots.map((card, slotIdx) => {
        if (!card) {
          return H('div', {
            key: `empty-${slotIdx}`,
            'data-cabinet-seat-slot': slotIdx,
            onDragOver: e => e.preventDefault(),
            onDrop: e => handleDropData(e, p => { if (p.type === 'model') placeModelInSlot(p.cardId, p.from, slotIdx); }),
            onClick: () => { if (selectedChip?.type === 'model') placeModelInSlot(selectedChip.cardId, selectedChip.from, slotIdx); },
            style: {
              minHeight: 144, borderRadius: 14, border: '1px dashed #c8d0d9', background: '#fafbfd',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              color: '#65717d', cursor: selectedChip?.type === 'model' ? 'pointer' : 'default', boxSizing: 'border-box'
            }
          },
            H('span', { style: { fontSize: 13 } }, `工作席 ${slotIdx + 1}`),
            H('span', { style: { fontSize: 12, marginTop: 4 } }, '拖入模型')
          );
        }
        return renderSeatedCard({ H, card, disabled, focusedRole, selectedChip, setDragData, handleDropData, addRoleToSeat, assignKindToDuty, removeDutyOrKind, cycleReasoningEffort });
      }),
      H('div', {
        'data-cabinet-slot-controls': '',
        style: {
          minHeight: 144, display: 'flex', flexDirection: 'column', gap: 8,
          justifyContent: 'center', boxSizing: 'border-box'
        }
      },
        canRemoveSlot && H('button', {
          type: 'button',
          disabled,
          'data-cabinet-remove-slot': '',
          onClick: removeWorkSlot,
          style: {
            flex: canAddSlot ? '0 0 44px' : '1 1 auto',
            minHeight: 42, borderRadius: 10,
            border: '1px solid #e0a0a0', background: '#fdf2f2',
            color: '#be3b3b', cursor: 'pointer', fontSize: 13, fontWeight: 500,
            display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box'
          }
        }, '－ 削减工作席'),
        canAddSlot && H('button', {
          type: 'button',
          disabled,
          'data-cabinet-add-slot': '',
          onClick: () => {
            if (selectedChip?.type === 'model') {
              addWorkSlot();
              placeModelInSlot(selectedChip.cardId, selectedChip.from, slotCount);
            } else {
              addWorkSlot();
            }
          },
          style: {
            flex: '1 1 auto',
            minHeight: canRemoveSlot ? 92 : 144, borderRadius: 12,
            border: '1px dashed #91acd5', background: '#f8fbff',
            color: '#3d609a', cursor: 'pointer', fontSize: 13, fontWeight: 500,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box'
          }
        }, `＋ 增加工作席（${slotCount}/9）`)
      )
    ),
    renderSecretarySlot({ H, draft, disabled, selectedChip, setSelectedChip, setDragData, handleDropData, assignSecretaryModel, clearSecretaryModel, cycleReasoningEffort })
  );
}

function renderSeatedCard({ H, card, disabled, focusedRole, selectedChip, setDragData, handleDropData, addRoleToSeat, assignKindToDuty, removeDutyOrKind, cycleReasoningEffort }) {
  const isFocused = focusedRole && (card.duties ?? []).some(d => d.role === focusedRole);
  const efforts = card.model?.reasoningEffortOptions ?? [];

  return H('div', {
    key: card.id,
    'data-cabinet-seat-card': card.id,
    draggable: !disabled,
    onDragStart: e => setDragData(e, { type: 'model', from: 'seat', cardId: card.id }),
    onDragOver: e => e.preventDefault(),
    onDrop: e => handleDropData(e, p => {
      if (p.type === 'role') addRoleToSeat(card.id, p.role);
      else if (p.type === 'kind' && (card.duties?.length ?? 0) === 1) assignKindToDuty(card.id, card.duties[0].role, p.kind);
    }),
    onClick: () => {
      if (selectedChip?.type === 'role') addRoleToSeat(card.id, selectedChip.role);
      else if (selectedChip?.type === 'kind' && (card.duties?.length ?? 0) === 1) assignKindToDuty(card.id, card.duties[0].role, selectedChip.kind);
    },
    style: {
      minHeight: 144, padding: 14, borderRadius: 14,
      background: isFocused ? '#edf3fd' : 'var(--dsw-alias-bg-base, #fff)',
      border: isFocused ? '1px solid #91acd5' : '1px solid #d9dfe5',
      display: 'flex', flexDirection: 'column', gap: 8
    }
  },
    H('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
      H('strong', {
        title: `${card.model?.providerName || card.model?.providerId} / ${card.model?.displayName || card.model?.modelId}`,
        style: { fontSize: 16 }
      }, card.label),
      H('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
        efforts.length > 0 && H('button', {
          type: 'button',
          onClick: e => { e.stopPropagation(); cycleReasoningEffort(card); },
          style: { padding: '2px 7px', borderRadius: 10, border: '1px solid #d7dee6', background: '#f1f4f7', fontSize: 11, cursor: 'pointer', color: '#3d609a' }
        }, `${card.model.reasoningEffort || efforts[0]} ▾`),
        H('span', { style: { color: '#65717d', cursor: 'grab' } }, '⠿')
      )
    ),
    (card.duties ?? []).length === 0 && H('div', { style: { fontSize: 12, color: '#65717d', marginTop: 8 } }, '拖入上方职务标签'),
    (card.duties ?? []).map(d => {
      const isLeader = d.kind === 'leader';
      return H('div', {
        key: d.role,
        'data-cabinet-duty-chip': `${card.id}-${d.role}`,
        draggable: !disabled,
        onDragStart: e => { e.stopPropagation(); setDragData(e, { type: isLeader ? 'kind-tag' : 'duty-tag', seatId: card.id, role: d.role }); },
        onDragOver: e => { e.preventDefault(); e.stopPropagation(); },
        onDrop: e => handleDropData(e, p => { if (p.type === 'kind') assignKindToDuty(card.id, d.role, p.kind); }),
        onClick: e => {
          e.stopPropagation();
          if (selectedChip?.type === 'kind') assignKindToDuty(card.id, d.role, selectedChip.kind);
        },
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
          padding: '5px 12px', borderRadius: 16, fontSize: 13, cursor: 'grab',
          background: isLeader ? '#dfeafb' : '#f1f4f7',
          border: isLeader ? '1px solid #91acd5' : '1px solid #d7dee6',
          color: isLeader ? '#3d609a' : '#26313d'
        }
      },
        H('span', null, `${ROLE_NAME_MAP[d.role]}席 · ${KIND_NAME_MAP[d.kind || 'independent']}`),
        H('button', {
          type: 'button',
          onClick: e => { e.stopPropagation(); removeDutyOrKind(card.id, d.role, isLeader); },
          style: { background: 'none', border: 0, cursor: 'pointer', color: '#65717d', padding: 0, fontSize: 12 }
        }, '×')
      );
    })
  );
}

function renderSecretarySlot({ H, draft, disabled, selectedChip, setSelectedChip, setDragData, handleDropData, assignSecretaryModel, clearSecretaryModel, cycleReasoningEffort }) {
  const secModel = draft.secretary?.model;
  if (!secModel) {
    return H('div', {
      'data-cabinet-secretary-slot': '',
      onDragOver: e => e.preventDefault(),
      onDrop: e => handleDropData(e, p => { if (p.type === 'model') assignSecretaryModel(p.cardId, p.from); }),
      onClick: () => { if (selectedChip?.type === 'model') assignSecretaryModel(selectedChip.cardId, selectedChip.from); },
      style: {
        minHeight: 144, padding: 14, borderRadius: 14,
        border: '1px dashed #c8d0d9', background: '#fafbfd',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        color: '#65717d', cursor: selectedChip?.type === 'model' ? 'pointer' : 'default', boxSizing: 'border-box'
      }
    },
      H('span', { style: { fontSize: 13 } }, '秘书席（可选）'),
      H('span', { style: { fontSize: 12, marginTop: 4 } }, '拖入模型')
    );
  }

  const efforts = secModel.reasoningEffortOptions ?? [];
  return H('div', {
    'data-cabinet-secretary-slot': '',
    draggable: !disabled,
    onDragStart: e => setDragData(e, { type: 'model', from: 'secretary', cardId: 'secretary' }),
    onDragOver: e => e.preventDefault(),
    onDrop: e => handleDropData(e, p => { if (p.type === 'model') assignSecretaryModel(p.cardId, p.from); }),
    onClick: () => { if (selectedChip?.type === 'model') assignSecretaryModel(selectedChip.cardId, selectedChip.from); },
    style: {
      minHeight: 144, padding: 14, borderRadius: 14, border: '1px solid #d9dfe5',
      background: 'var(--dsw-alias-bg-base, #fff)', display: 'flex', flexDirection: 'column', gap: 8, boxSizing: 'border-box'
    }
  },
    H('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
      H('span', { style: { fontSize: 12, color: '#65717d' } }, '秘书席（独立计数）'),
      H('button', {
        type: 'button',
        title: '移回待放区',
        onClick: e => { e.stopPropagation(); clearSecretaryModel(); },
        style: { background: 'none', border: 0, cursor: 'pointer', color: '#65717d', padding: 0, fontSize: 14 }
      }, '×')
    ),
    H('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
      H('strong', {
        title: `${secModel.providerName || secModel.providerId} / ${secModel.displayName || secModel.modelId}`,
        style: { fontSize: 16 }
      }, draft.secretary?.label || secModel.shortLabel),
      efforts.length > 0 && H('button', {
        type: 'button',
        onClick: e => {
          e.stopPropagation();
          cycleReasoningEffort('secretary');
        },
        style: { padding: '2px 7px', borderRadius: 10, border: '1px solid #d7dee6', background: '#f1f4f7', fontSize: 11, cursor: 'pointer', color: '#3d609a' }
      }, `${secModel.reasoningEffort || efforts[0]} ▾`)
    ),
    H('div', { style: { padding: '5px 10px', borderRadius: 14, background: '#f1f4f7', border: '1px solid #d7dee6', fontSize: 12, color: '#65717d' } }, '阶段汇报 · 最终总结')
  );
}

const cabinetV2Ui = globalThis.__dshCabinetV2Ui ?? {};
cabinetV2Ui.ConfigEditor = CabinetV2ConfigEditor;
cabinetV2Ui.formatErrors = cabinetV2Errors;
cabinetV2Ui.clone = cabinetV2Clone;
cabinetV2Ui.taskOpeners ??= new Map();
cabinetV2Ui.openTaskSettings = sessionId => {
  const open = cabinetV2Ui.taskOpeners.get(sessionId);
  if (typeof open === 'function') return open();
};
cabinetV2Ui.taskFromPlan = (plan, sessionId) => ({
  ...normalizeDraftConfig(plan),
  kind: 'task',
  taskId: sessionId,
  configVersion: 1,
  goal: '',
  constraints: ''
});
globalThis.__dshCabinetV2Ui = cabinetV2Ui;
globalThis.dispatchEvent(new Event('dsh-cabinet-v2-ui-ready'));








    var PACKAGE_ID = "dsh-cabinet";
    var VERSION = "0.3.0";
    var SETTINGS_SLOT = "settings.section";
    var SETTINGS_ICON_SLOT = "settings.section.icon";
    var MODEL_OPTIONS_SLOT = "conversation.input.model.options";
    var INPUT_OVERLAY_SLOT = "conversation.input.overlay";
    var SETTINGS_ENTRY_ID = "dsh-cabinet-settings";
    var SETTINGS_ORDER = 64;
    var REPO_URL = "https://github.com/sxczzl2008/dsh-cabinet";
    var STYLE_ID = "dsh-cabinet-settings-styles";

    var GITHUB_ICON_PATH =
      "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12";

    var CSS = [
      ".dcab-set{display:flex;flex-direction:column;gap:18px;max-width:980px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6}",
      ".dcab-head{display:flex;flex-direction:column;gap:6px}",
      ".dcab-brand{display:flex;align-items:center;gap:12px;flex-wrap:wrap}",
      ".dcab-title{margin:0;font-size:20px;font-weight:650;letter-spacing:-.01em}",
      ".dcab-link{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,#d7dee6);border-radius:999px;font-size:12px;color:var(--dsw-alias-label-secondary,#65717d);text-decoration:none}",
      ".dcab-link:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f4f7);color:var(--dsw-alias-label-primary)}",
      ".dcab-version{font-size:12px;color:var(--dsw-alias-label-tertiary,#86909c)}",
      ".dcab-card{display:flex;flex-direction:column;gap:12px;padding:18px 20px;border-radius:14px;border:1px solid var(--dsw-alias-border-l1,#e3e8ee);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base,#fff))}",
      ".dcab-card__title{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".dcab-guide-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}",
      ".dcab-guide-item{padding:12px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f7f9fb);border:1px solid var(--dsw-alias-border-l1,#e8edf2)}",
      ".dcab-guide-item b{display:block;margin-bottom:4px;font-size:13px;color:var(--dsw-alias-label-primary)}",
      ".dcab-guide-item span{font-size:12px;color:var(--dsw-alias-label-secondary,#65717d)}",
      ".dcab-rows{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 16px;margin:0;align-items:baseline}",
      ".dcab-rows dt{color:var(--dsw-alias-label-secondary,#65717d);white-space:nowrap}",
      ".dcab-rows dd{margin:0;min-width:0;overflow-wrap:anywhere}",
      ".dcab-btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 14px;font:inherit;font-size:13px;font-weight:500;cursor:pointer;border-radius:8px;border:1px solid #3d609a;background:#3d609a;color:#fff}",
      ".dcab-btn:disabled{opacity:.55;cursor:not-allowed}",
      ".dcab-btn--quiet{background:transparent;color:var(--dsw-alias-label-secondary,#65717d);border-color:var(--dsw-alias-border-l1,#d7dee6)}",
      ".dcab-btn--quiet:hover{background:var(--dsw-alias-bg-layer-2,#f1f4f7);color:var(--dsw-alias-label-primary)}"
    ].join("");

    function installStyles() {
      if (typeof document === "undefined") return;
      var el = document.getElementById(STYLE_ID);
      if (!el) {
        el = document.createElement("style");
        el.id = STYLE_ID;
        document.head.appendChild(el);
      }
      el.textContent = CSS;
    }

    function SettingsNavIcon(props) {
      var size = props && typeof props.size === "number" ? props.size : 16;
      return React.createElement(
        "svg",
        { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 16 16", width: size, height: size, fill: "currentColor", "aria-hidden": "true" },
        React.createElement("rect", { x: 1.5, y: 2, width: 5.5, height: 5.2, rx: 1.2 }),
        React.createElement("rect", { x: 9, y: 2, width: 5.5, height: 5.2, rx: 1.2 }),
        React.createElement("rect", { x: 1.5, y: 8.8, width: 5.5, height: 5.2, rx: 1.2 }),
        React.createElement("circle", { cx: 11.75, cy: 11.4, r: 2.6 })
      );
    }

    function CabinetCompletedTasks(props) {
      var H = React.createElement, bridge = globalThis.__dshCabinetV2;
      var _tasks = React.useState([]), tasks = _tasks[0], setTasks = _tasks[1];
      var _selected = React.useState(''), selected = _selected[0], setSelected = _selected[1];
      var _busy = React.useState(true), busy = _busy[0], setBusy = _busy[1];
      var _error = React.useState(''), error = _error[0], setError = _error[1];
      var _notice = React.useState(''), notice = _notice[0], setNotice = _notice[1];
      var _loaded = React.useState(false), loaded = _loaded[0], setLoaded = _loaded[1];
      var loadSequence = React.useRef(0);
      var keyOf = function (task) { return JSON.stringify([task.parentSessionId, task.taskId]); };
      var load = async function () {
        var sequence = ++loadSequence.current;
        var result = await bridge.completedTasks(props?.sessionId);
        if (sequence !== loadSequence.current) return;
        var rows = result.tasks.filter(function (task) { return !props?.sessionId || task.parentSessionId === props.sessionId; });
        setTasks(rows); setLoaded(true);
        setSelected(function (value) { return rows.some(function (task) { return keyOf(task) === value; }) ? value : ''; });
        setError(result.unavailable.length ? '有 ' + result.unavailable.length + ' 项记录读取失败，已保留，可刷新重试。' : '');
        return rows;
      };
      var refresh = async function () {
        if (busy || props?.disabled) return;
        setBusy(true); setError('');
        try { await load(); } catch (err) { setLoaded(false); setError(err.message || '读取已结束任务未完成'); }
        finally { setBusy(false); }
      };
      React.useEffect(function () {
        var active = true;
        setBusy(true); setError('');
        load().catch(function (err) { if (active) { setLoaded(false); setError(err.message || '读取已结束任务未完成'); } })
          .finally(function () { if (active) setBusy(false); });
        return function () { active = false; ++loadSequence.current; };
      }, [props?.sessionId]);
      var remove = async function () {
        if (busy || props?.disabled) return;
        var task = tasks.find(function (row) { return keyOf(row) === selected; });
        if (!task || !window.confirm('永久删除已结束任务「' + task.goal + '」及其独占、无引用的组聊和内部记录，不可还原。主会话、正式成果和共享记录保留。继续？')) return;
        setBusy(true); setError(''); setNotice('');
        if (props?.onBusyChange) props.onBusyChange(true);
        try {
          var fact = await bridge.refresh(task.parentSessionId);
          var result = await bridge.deleteTask(task.parentSessionId, task.taskId, fact.configVersion);
          ++loadSequence.current;
          setSelected(''); setTasks(function (rows) { return rows.filter(function (row) { return keyOf(row) !== keyOf(task); }); });
          setNotice('已永久删除此任务，清除 ' + result.cleanup.deletedFiles + ' 个内部记录、' + result.cleanup.deletedSessions.length + ' 个组聊。' + (result.cleanup.blocked.length ? '仍占用或无法核实的记录已保留，可释放后用全局清理按钮重试。' : '正式成果与共享记录保留。'));
          var refreshed = await Promise.allSettled([load(), props?.onDeleted ? props.onDeleted(task) : Promise.resolve()]);
          if (refreshed.some(function (row) { return row.status === 'rejected'; })) { setLoaded(false); setError('任务已永久删除，列表刷新失败，请点击刷新已结束任务。'); }
        } catch (err) { setError(err.message || '删除未完成'); }
        finally { setBusy(false); if (props?.onBusyChange) props.onBusyChange(false); }
      };
      var activeTask = tasks.find(function (row) { return keyOf(row) === selected; }) || null;
      return H('section', { className: 'dcab-card', 'data-cabinet-completed-tasks': '' },
        H('h3', { className: 'dcab-card__title' }, '已结束任务'),
        H('p', { style: { color: '#65717d', fontSize: 13 } }, '完成并退出内阁后，仍可在此打开子对话历史或删除索引，无需重新开启内阁。'),
        H('select', { 'aria-label': '选择已结束任务', disabled: busy || props?.disabled, value: selected, style: { maxWidth: '100%', minWidth: 220 }, onChange: function (event) { setSelected(event.target.value); setNotice(''); } },
          H('option', { value: '' }, busy ? '正在读取…' : !loaded ? '读取失败，请刷新重试' : tasks.length ? '请选择已结束任务' : error ? '部分记录读取失败，请重试' : '暂无已结束任务'),
          tasks.map(function (task) { return H('option', { key: keyOf(task), value: keyOf(task) }, task.goal + ' · ' + (task.statusLabel || '已结束') + ' · ' + task.taskId.slice(-8)); })
        ),
        H('button', { type: 'button', disabled: busy || props?.disabled || !selected, onClick: remove, style: { marginLeft: 8, color: '#a33' } }, '永久删除此任务'),
        H('button', { type: 'button', disabled: busy || props?.disabled, onClick: refresh, style: { marginLeft: 8 } }, '刷新已结束任务'),
        activeTask && H('div', { style: { marginTop: 10, padding: 10, borderRadius: 8, background: 'var(--dsw-alias-bg-secondary, #f5f7fa)', border: '1px solid #d7dee6', fontSize: 12 } },
          H('div', { style: { fontWeight: 600, marginBottom: 6 } }, activeTask.goal + '（' + (activeTask.statusLabel || '已结束') + '）'),
          H('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
            !props?.sessionId && activeTask.parentSessionId && H('button', { type: 'button', style: { padding: '4px 10px', borderRadius: 6, border: '1px solid #91acd5', background: '#edf3fd', color: '#3d609a', cursor: 'pointer', fontSize: 12 }, onClick: function () { cabinetV2Ui.openGroupConversation(activeTask.parentSessionId); } }, '打开原主对话'),
            (activeTask.subagents || []).map(function (sub) {
              return H('button', {
                key: sub.childId, type: 'button',
                style: { padding: '4px 10px', borderRadius: 6, border: '1px solid #d7dee6', background: 'var(--dsw-alias-bg-base, #fff)', color: '#3d609a', cursor: 'pointer', fontSize: 12 },
                onClick: function () { cabinetV2Ui.openGroupConversation(sub.childId); }
              }, sub.label || sub.name);
            })
          )
        ),
        error && H('div', { role: 'alert', style: { color: '#a33' } }, error),
        notice && H('div', { role: 'status' }, notice)
      );
    }

    function CabinetSettingsPage() {
      var H = React.createElement;
      var bridge = globalThis.__dshCabinetV2;
      var ui = globalThis.__dshCabinetV2Ui;
      var Editor = ui && ui.ConfigEditor;

      var _draft = React.useState(null), draft = _draft[0], setDraft = _draft[1];
      var _rev = React.useState(1), revision = _rev[0], setRevision = _rev[1];
      var _runtimeInfo = React.useState(null), runtimeInfo = _runtimeInfo[0], setRuntimeInfo = _runtimeInfo[1];
      var _busy = React.useState(false), busy = _busy[0], setBusy = _busy[1];
      var _notice = React.useState(""), notice = _notice[0], setNotice = _notice[1];
      var _error = React.useState(""), error = _error[0], setError = _error[1];
      var _tick = React.useState(0), setTick = _tick[1];

      var load = React.useCallback(function () {
        if (!bridge || !bridge.getPlan) return;
        setBusy(true); setError(""); setNotice("");
        bridge.getPlan().then(function (res) {
          setDraft(JSON.parse(JSON.stringify(res.plan)));
          setRevision(res.revision || 1);
          if (res.runtimeInfo) setRuntimeInfo(res.runtimeInfo);
        }).catch(function (e) {
          setError(e.message || "读取全局默认方案未完成");
        }).finally(function () {
          setBusy(false);
        });
      }, [bridge]);

      React.useEffect(function () {
        var refresh = function () { setTick(function (n) { return n + 1; }); load(); };
        load();
        window.addEventListener("dsh-cabinet-v2-ready", refresh);
        window.addEventListener("dsh-cabinet-v2-ui-ready", refresh);
        return function () {
          window.removeEventListener("dsh-cabinet-v2-ready", refresh);
          window.removeEventListener("dsh-cabinet-v2-ui-ready", refresh);
        };
      }, [load]);

      var saveMasterPlan = function () {
        if (!draft || busy || !bridge || !bridge.savePlan) return;
        setBusy(true); setError(""); setNotice("");
        bridge.savePlan(draft, revision).then(function (res) {
          setDraft(JSON.parse(JSON.stringify(res.plan)));
          setRevision(res.revision);
          setNotice("✓ 已保存为全局默认方案（母本 v" + res.revision + "），新建内阁对话将自动采用此配置");
        }).catch(function (e) {
          setError(e.message || "保存未完成");
        }).finally(function () {
          setBusy(false);
        });
      };

      var resetBlankMaster = function () {
        var blank = {
          schemaVersion: 2,
          blankDefaultInitialized: true,
          kind: "plan",
          id: "default-cabinet-plan",
          slotCount: 3,
          secretary: { id: "secretary", label: "秘书席", model: null },
          seats: [],
          staging: [],
          policies: { handoff: "wait", humanApprovalRequired: false, memberPool: { scope: "group", seatIds: [] } }
        };
        setDraft(blank);
        setNotice("已重置为空白草稿，点击「保存全局默认方案」生效");
      };
      var clearDeletedTaskCaches = async function () {
        if (busy || !window.confirm('永久清除已明确删除任务中无引用的独占缓存和组聊，不可还原。主会话、正式成果、未删除任务和归属不明内容会保留。继续？')) return;
        setBusy(true); setError(''); setNotice('');
        try {
          var result = await bridge.clearDeletedTaskCaches();
          var files = result.results.reduce(function (n, row) { return n + row.deletedFiles; }, 0);
          var sessions = result.results.reduce(function (n, row) { return n + row.deletedSessions.length; }, 0);
          var blocked = result.results.reduce(function (n, row) { return n + row.blocked.length; }, 0);
          setNotice('已清除 ' + files + ' 个内部记录、' + sessions + ' 个组聊。' + (blocked ? '仍有 ' + blocked + ' 项因占用或证据不足而保留，可释放后再清理。' : '未删除任务和正式成果保留。'));
        } catch (err) { setError(err.message || '清理未完成'); }
        finally { setBusy(false); }
      };
      return renderSettingsContent({ H, VERSION, REPO_URL, GITHUB_ICON_PATH, revision, runtimeInfo, error, notice, draft, setDraft, setNotice, Editor, busy, saveMasterPlan, resetBlankMaster, clearDeletedTaskCaches, load });
    }

    function renderSettingsContent(p) {
      var H = p.H;
      return H("div", { className: "dcab-set", "data-cabinet-root-settings": "" },
        H("div", { className: "dcab-head" },
          H("div", { className: "dcab-brand" },
            H("h2", { className: "dcab-title" }, "内阁模式"),
            H("a", { className: "dcab-link", href: p.REPO_URL, target: "_blank", rel: "noopener noreferrer" },
              H("svg", { style: { width: 13, height: 13, display: "block" }, viewBox: "0 0 24 24", "aria-hidden": "true" },
                H("path", { fill: "currentColor", d: p.GITHUB_ICON_PATH })
              ),
              "GitHub"
            ),
            H("span", { className: "dcab-version" }, "v" + p.VERSION)
          )
        ),

        H("section", { className: "dcab-card" },
          H("h3", { className: "dcab-card__title" }, "使用指引（快速上手）"),
          H("div", { className: "dcab-guide-grid" },
            H("div", { className: "dcab-guide-item" },
              H("b", null, "1. 如何进入内阁模式"),
              H("span", null, "在任意聊天对话输入框右下角的「模型选择下拉菜单」底部，点击「内阁模式」即可弹出本任务排席窗口；应用后对话右侧自动挂出窄版状态栏。")
            ),
            H("div", { className: "dcab-guide-item" },
              H("b", null, "2. 鼠标点选与气泡拖拽"),
              H("span", null, "从右上角下拉框点选模型生成气泡，拖入下方工作席（1～9 席，可同列增减）或右侧秘书席（可选），再把「设计席 / 施工席 / 审验席」与「组长 / 组员 / 独立」拖入模型卡片。")
            ),
            H("div", { className: "dcab-guide-item" },
              H("b", null, "3. 全局母本与对话子代关系"),
              H("span", null, "本页保存的是「全局默认母本」，新开内阁对话会自动带入；在单个对话内调整排席只作用于该对话（子代），也可在对话弹窗底部点「一键设为默认配置」反向更新母本。")
            ),
            H("div", { className: "dcab-guide-item" },
              H("b", null, "4. 状态栏三色进度与控制"),
              H("span", null, "红 = 出错需人工排障；黄 = 思考/讨论/执行工具中；绿 = 正式成果已转交。支持随时查看组内讨论、发送补充指令、单独停止某组或停止全部工作。")
            )
          )
        ),

        H("section", { className: "dcab-card" },
          H("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 } },
            H("h3", { className: "dcab-card__title" }, "全局默认方案（母本配置）"),
            H("span", { style: { fontSize: 12, color: "#65717d" } }, "新开启「内阁模式」的对话将默认载入此方案 · 当前母本版本 v" + p.revision)
          ),
          p.error && H("div", { role: "alert", style: { color: "#be6262", fontSize: 13 } }, p.error),
          p.notice && H("div", { role: "status", style: { color: "#2d8f54", fontSize: 13 } }, p.notice),
          p.draft && typeof p.Editor === "function"
            ? H(p.Editor, { value: p.draft, onChange: function (v) { p.setDraft(v); p.setNotice(""); }, disabled: p.busy, context: "plan" })
            : H("p", { style: { color: "#65717d", margin: 0 } }, "正在加载内阁画布组件…"),
          H("div", { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 4 } },
            H("button", { type: "button", className: "dcab-btn", disabled: p.busy || !p.draft, onClick: p.saveMasterPlan }, p.busy ? "保存中…" : "保存全局默认方案"),
            H("button", { type: "button", className: "dcab-btn dcab-btn--quiet", disabled: p.busy, onClick: p.resetBlankMaster }, "重置为空白默认"),
            H("button", { type: "button", className: "dcab-btn dcab-btn--quiet", disabled: p.busy, onClick: p.load }, "重新读取已保存母本"),
            H("button", { type: "button", className: "dcab-btn dcab-btn--quiet", disabled: p.busy, onClick: p.clearDeletedTaskCaches }, "清除已删除任务的缓存")
          )
        ),

        H(CabinetCompletedTasks, null),

        H("section", { className: "dcab-card" },
          H("h3", { className: "dcab-card__title" }, "插件与运行状态"),
          H("dl", { className: "dcab-rows" },
            H("dt", null, "插件名称"), H("dd", null, "dsh-cabinet（内阁多模型协作工作流）"),
            H("dt", null, "当前版本"), H("dd", null, "v" + p.VERSION),
            H("dt", null, "插件目录"), H("dd", null, (p.runtimeInfo && p.runtimeInfo.pluginPath) || "由当前 DSH Profile 动态加载"),
            H("dt", null, "母本存储"), H("dd", null, (p.runtimeInfo && p.runtimeInfo.planFilePath) || "$DSH_HOME/cabinet-v2/saved-plan.json"),
            H("dt", null, "对话入口"), H("dd", null, "原对话输入框右下角模型选择菜单 → 内阁模式")
          )
        )
      );
    }

    function CabinetV2ModeOption(props) {
      var snapshot = globalThis.__dshCabinetV2.snapshot(props.sessionId);
      if (snapshot.nativeGroup || snapshot.mode === 'cabinet-group') return null;
      return React.createElement("button", {
        type: "button",
        role: "menuitem",
        disabled: props.locked,
        "aria-haspopup": "dialog",
        "aria-label": "内阁模式",
        "data-cabinet-v2-mode-entry": "",
        onClick: function () {
          props.dismiss();
          cabinetV2Ui.openTaskSettings(props.sessionId);
        },
        style: {
          display: "flex",
          alignItems: "center",
          width: "100%",
          minHeight: 32,
          padding: "6px 12px",
          border: 0,
          background: "transparent",
          color: "inherit",
          font: "inherit",
          fontSize: 13,
          textAlign: "left",
          cursor: props.locked ? "not-allowed" : "pointer",
          opacity: props.locked ? 0.55 : 1
        }
      }, snapshot.mode === "cabinet" ? "✓ 内阁模式" : "内阁模式");
    }

    function CabinetV2TaskSettingsHost(props) {
      var sessionId = props.sessionId;
      var v2Bridge = globalThis.__dshCabinetV2;
      var _bump = react.useState(0), v2Bump = _bump[1];
      var _modal = react.useState(false), v2ModalOpen = _modal[0], v2SetModalOpen = _modal[1];
      var _draft = react.useState(null), v2DraftTask = _draft[0], v2SetDraftTask = _draft[1];
      var _expected = react.useState(0), v2ExpectedVersion = _expected[0], v2SetExpectedVersion = _expected[1];
      var _plan = react.useState(1), v2PlanRev = _plan[0], v2SetPlanRev = _plan[1];
      var _loading = react.useState(false), v2Loading = _loading[0], v2SetLoading = _loading[1];
      var _saving = react.useState(false), v2Saving = _saving[0], v2SetSaving = _saving[1];
      var _notice = react.useState(""), v2NoticeText = _notice[0], v2SetNoticeText = _notice[1];
      var _errors = react.useState([]), v2ErrorMessages = _errors[0], v2SetErrorMessages = _errors[1];
      var _choice = react.useState(null), v2EntryChoice = _choice[0], v2SetEntryChoice = _choice[1];
      var _resume = react.useState(null), v2ResumePreview = _resume[0], v2SetResumePreview = _resume[1];
      var _history = react.useState([]), v2TaskHistory = _history[0], v2SetTaskHistory = _history[1];
      var _historyState = react.useState('loading'), v2HistoryState = _historyState[0], v2SetHistoryState = _historyState[1];
      var _factReady = react.useState(false), v2FactReady = _factReady[0], v2SetFactReady = _factReady[1];
      var _secretaryChoice = react.useState(''), v2SecretaryChoice = _secretaryChoice[0], v2SetSecretaryChoice = _secretaryChoice[1];
      var v2ReadSequence = react.useRef(0);
      var v2EditorState = react.useRef(null);
      v2EditorState.current = { choice: v2EntryChoice, draft: v2DraftTask };

      var v2ReadConfiguration = async function (options) {
        options = options || {};
        var sequence = ++v2ReadSequence.current;
        v2SetLoading(true); v2SetErrorMessages([]); v2SetHistoryState('loading'); v2SetFactReady(false);
        // All panels read independently; a failed preview must leave history reachable.
        var results = await Promise.allSettled([v2Bridge.getPlan(), v2Bridge.refresh(sessionId), v2Bridge.taskHistory(sessionId), v2Bridge.resumePreview(sessionId)]);
        if (sequence !== v2ReadSequence.current) return;
        var labels = ['全局默认配置', '当前配置', '讨论历史', '接续位置'];
        var errors = [];
        results.forEach(function (result, index) { if (result.status === 'rejected') errors.push(labels[index] + '读取失败：' + cabinetV2Errors(result.reason).join('；')); });
        var saved = results[0].status === 'fulfilled' ? results[0].value : null;
        var fact = results[1].status === 'fulfilled' ? results[1].value : null;
        var preview = results[3].status === 'fulfilled' ? results[3].value : null;
        v2SetFactReady(!!fact);
        if (saved) v2SetPlanRev(saved.revision || 1);
        if (fact) v2SetExpectedVersion(Number.isSafeInteger(fact.configVersion) ? fact.configVersion : 0);
        if (results[2].status === 'fulfilled') { v2SetTaskHistory(results[2].value); v2SetHistoryState('ready'); }
        else v2SetHistoryState('error');
        var current = fact && (fact.config || fact.task);
        v2SetResumePreview(current && preview?.taskId === current.taskId ? preview : null);
        v2SetSecretaryChoice('');
        var editor = v2EditorState.current;
        if (!options.fresh && editor.choice === 'new' && editor.draft) {
          // Preserve the independent draft the user is already editing.
        } else if (fact && !current && saved) {
          var fresh = cabinetV2Ui.taskFromPlan(saved.plan, sessionId);
          fresh.goal = ''; fresh.constraints = '';
          v2SetDraftTask(fresh); v2SetEntryChoice('new');
        } else if (fact && current) {
          v2SetDraftTask(cabinetV2Clone(current));
          v2SetEntryChoice(preview?.kind === 'root-finalizing' || !options.fresh && editor.choice === 'resume' && preview?.taskId === current.taskId ? 'resume' : null);
        } else {
          v2SetDraftTask(null); v2SetEntryChoice(null);
        }
        v2SetErrorMessages(errors); v2SetLoading(false);
      };
      var v2OpenConfiguration = async function () {
        v2SetModalOpen(true); v2SetNoticeText(''); v2SetEntryChoice(null); v2SetResumePreview(null); v2SetDraftTask(null); v2SetTaskHistory([]);
        await v2ReadConfiguration({ fresh: true });
      };
      var v2CancelConfiguration = function () {
        if (v2Saving) return;
        ++v2ReadSequence.current;
        v2SetModalOpen(false); v2SetDraftTask(null); v2SetErrorMessages([]); v2SetNoticeText("");
      };
      var v2PromoteToDefaultPlan = async function () {
        if (v2Saving || v2Loading || !v2DraftTask) return;
        v2SetSaving(true); v2SetErrorMessages([]); v2SetNoticeText("");
        try {
          var res = await v2Bridge.savePlan(v2DraftTask, v2PlanRev);
          v2SetPlanRev(res.revision || (v2PlanRev + 1));
          v2SetNoticeText("✓ 已将当前排席设为全局默认配置（母本 v" + (res.revision || (v2PlanRev + 1)) + "）");
        } catch (err) {
          v2SetErrorMessages(cabinetV2Errors(err));
        } finally {
          v2SetSaving(false);
        }
      };
      var v2ReloadFromDefaultPlan = async function () {
        if (v2Saving || v2Loading) return;
        var sequence = ++v2ReadSequence.current;
        v2SetLoading(true); v2SetErrorMessages([]); v2SetNoticeText("");
        try {
          var saved = await v2Bridge.getPlan();
          if (sequence !== v2ReadSequence.current) return;
          v2SetPlanRev((saved && saved.revision) || 1);
          v2SetDraftTask(cabinetV2Ui.taskFromPlan(saved.plan, sessionId));
          v2SetNoticeText("已从全局默认配置载入排席");
        } catch (err) {
          if (sequence === v2ReadSequence.current) v2SetErrorMessages(cabinetV2Errors(err));
        } finally {
          if (sequence === v2ReadSequence.current) v2SetLoading(false);
        }
      };
      var v2ChooseNewConfiguration = async function () {
        if (v2Saving || v2Loading) return;
        var sequence = ++v2ReadSequence.current;
        v2SetLoading(true); v2SetErrorMessages([]); v2SetNoticeText("");
        try {
          var saved = await v2Bridge.getPlan();
          if (sequence !== v2ReadSequence.current) return;
          var fact = await v2Bridge.refresh(sessionId);
          if (sequence !== v2ReadSequence.current) return;
          v2SetFactReady(true);
          var fresh = cabinetV2Ui.taskFromPlan(saved.plan, sessionId);
          fresh.goal = ""; fresh.constraints = "";
          v2SetDraftTask(fresh); v2SetEntryChoice('new');
          v2SetPlanRev(saved.revision || 1);
          v2SetExpectedVersion(fact.configVersion);
        } catch (err) { if (sequence === v2ReadSequence.current) v2SetErrorMessages(cabinetV2Errors(err)); }
        finally { if (sequence === v2ReadSequence.current) v2SetLoading(false); }
      };
      var v2DetachTarget = v2FactReady && v2Bridge.snapshot(sessionId).associatedTaskId;
      var v2CanDetach = v2FactReady && v2Bridge.snapshot(sessionId).canDetachConfiguration;
      var v2DetachConfiguration = async function () {
        if (v2Saving || v2Loading || !v2CanDetach) return;
        v2SetSaving(true); v2SetErrorMessages([]); v2SetNoticeText('');
        try {
          var fact = await v2Bridge.refresh(sessionId);
          v2SetExpectedVersion(fact.configVersion);
          if (!fact.associatedTaskId) {
            await v2ReadConfiguration();
            v2SetNoticeText('当前没有配置关联，无需移除');
            return;
          }
          if (fact.associatedTaskId !== v2DetachTarget) {
            await v2ReadConfiguration();
            v2SetNoticeText('配置关联已变化，请核对当前任务后再操作');
            return;
          }
          await v2Bridge.detachConfiguration(sessionId, fact.associatedTaskId, fact.configVersion);
          await v2ReadConfiguration();
          v2SetNoticeText("已移除当前配置关联，组聊、成果和任务历史仍保留");
        } catch (err) { v2SetErrorMessages(cabinetV2Errors(err)); }
        finally { v2SetSaving(false); }
      };
      var v2AfterDeleted = async function (task) {
        ++v2ReadSequence.current;
        v2SetResumePreview(function (preview) { return preview?.taskId === task.taskId ? null : preview; });
        v2SetTaskHistory(function (rows) { return rows.filter(function (row) { return row.taskId !== task.taskId; }); });
        var editor = v2EditorState.current;
        if (editor.choice !== 'new' && editor.draft?.taskId === task.taskId) { v2SetDraftTask(null); v2SetEntryChoice(null); }
        await v2ReadConfiguration();
      };
      var v2ApplyConfiguration = async function () {
        if (v2Saving || v2Loading || !v2FactReady || v2EntryChoice !== 'new' || !v2DraftTask) return;
        v2SetSaving(true); v2SetErrorMessages([]); v2SetNoticeText("");
        try {
          var payload = cabinetV2Clone(v2DraftTask);
          payload.configVersion = v2ExpectedVersion + 1;
          await v2Bridge.applyTask(sessionId, payload, v2ExpectedVersion);
          await v2Bridge.refresh(sessionId);
          v2SetModalOpen(false); v2SetDraftTask(null);
        } catch (err) {
          v2SetErrorMessages(cabinetV2Errors(err));
        } finally {
          v2SetSaving(false);
        }
      };
      var v2ContinueCheckpoint = async function () {
        if (v2Saving || v2Loading || !v2FactReady || v2EntryChoice !== 'resume' || !v2ResumePreview?.ok) return;
        v2SetSaving(true); v2SetErrorMessages([]); v2SetNoticeText("");
          v2SetModalOpen(false);
        try {
          var selectedSecretary = v2SecretaryChoice ? (v2Bridge.catalog()?.models || []).find(function (model) { return JSON.stringify([model.providerId, model.modelId]) === v2SecretaryChoice; }) : undefined;
          if (v2SecretaryChoice && !selectedSecretary) throw new Error('所选秘书模型已变化，请刷新任务面板后重新选择');
          var resumed = await v2Bridge.resumeCheckpoint(sessionId, v2ResumePreview, selectedSecretary);
          if (v2ResumePreview.kind === 'root-finalizing' && resumed.result?.stopped) throw new Error(resumed.result.run?.error || '秘书总结尚未完成，请查看当前状态后重试');
          await v2Bridge.refresh(sessionId);
          v2SetModalOpen(false); v2SetDraftTask(null);
        } catch (err) {
            v2SetModalOpen(true);
          await v2ReadConfiguration();
          v2SetErrorMessages(function (errors) { return cabinetV2Errors(err).concat(errors); });
        } finally { v2SetSaving(false); }
      };
      var v2SeatPosition = function (seat) {
        var phases = { opening: '组长开场', member: '组员讨论', formal: '正式成果', independent: '独立席成果', 'secretary-final': '最终总结', construction: '施工成果', design: '设计成果' };
        return seat ? [seat.label || seat.actorLabel || seat.actorId || seat.seatId, phases[seat.phase] || seat.phase, seat.discussionRound ? '第 ' + seat.discussionRound + ' 轮' : ''].filter(Boolean).join(' · ') : '尚无法核实';
      };
      var v2ResumeFault = typeof v2ResumePreview?.fault === 'string' ? v2ResumePreview.fault : v2ResumePreview?.fault?.reason || v2ResumePreview?.fault?.message;

      react.useEffect(function () {
        var notify = function () { v2Bump(function (value) { return value + 1; }); };
        var off = v2Bridge.subscribe(notify);
        v2Bridge.refresh(sessionId).catch(function () {});
        globalThis.addEventListener("dsh-cabinet-v2-ready", notify);
        return function () {
          ++v2ReadSequence.current;
          off();
          globalThis.removeEventListener("dsh-cabinet-v2-ready", notify);
        };
      }, [sessionId, v2Bridge]);

      react.useEffect(function () {
        var opener = function () { return v2OpenConfiguration(); };
        cabinetV2Ui.taskOpeners.set(sessionId, opener);
        return function () {
          if (cabinetV2Ui.taskOpeners.get(sessionId) === opener) cabinetV2Ui.taskOpeners.delete(sessionId);
        };
      }, [sessionId, v2Bridge]);

      if (!v2ModalOpen) return null;
      return react_dom.createPortal(
        react.createElement("div", {
          role: "dialog", "aria-modal": "true", "aria-label": "本任务设置",
          "data-cabinet-v2-task-modal": sessionId,
          onKeyDown: function (e) { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); v2CancelConfiguration(); } },
          onClick: function (e) { if (e.target === e.currentTarget) v2CancelConfiguration(); },
          style: {
            position: "fixed", inset: 0, zIndex: 9999,
            background: "rgba(15, 23, 42, 0.45)",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: "16px", boxSizing: "border-box"
          }
        },
          react.createElement("div", {
            onClick: function (e) { return e.stopPropagation(); },
            style: {
              boxSizing: "border-box",
              width: "clamp(320px, 92vw, 1260px)",
              height: "clamp(360px, 88vh, 860px)",
              maxWidth: "calc(100vw - 24px)",
              maxHeight: "calc(100vh - 24px)",
              display: "flex", flexDirection: "column",
              borderRadius: "16px",
              background: "var(--dsw-alias-bg-base, #ffffff)",
              color: "var(--dsw-alias-label-primary, #26313d)",
              border: "1px solid var(--dsw-alias-border-l2, #cdd8e5)",
              boxShadow: "0 20px 50px rgba(0, 0, 0, 0.24)",
              overflow: "hidden"
            }
          },
            react.createElement("header", {
              style: {
                flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "14px 22px", borderBottom: "1px solid var(--dsw-alias-border-l3, #e8edf2)"
              }
            },
              react.createElement("div", { style: { display: "flex", alignItems: "baseline", gap: 12 } },
                react.createElement("strong", { style: { fontSize: 18 } }, "内阁模式 · 本对话配置（子代）"),
                react.createElement("span", { style: { fontSize: 12, color: "#65717d" } }, "修改仅作用于当前对话，不改变全局母本")
              ),
              react.createElement("button", {
                type: "button", onClick: v2CancelConfiguration, "aria-label": "关闭",
                style: { background: "none", border: 0, fontSize: 20, lineHeight: 1, color: "#65717d", cursor: "pointer", padding: "2px 6px" }
              }, "×")
            ),
            react.createElement("div", {
              className: "cabinet-v2-modal-body",
              style: { flex: "1 1 auto", minHeight: 0, overflowY: "auto", overflowX: "auto", padding: "18px 22px", boxSizing: "border-box" }
            },
              v2Loading && react.createElement("p", { role: "status", style: { color: "#65717d" } }, "正在读取配置…"),
              v2NoticeText && react.createElement("div", { role: "status", style: { color: "#2d8f54", marginBottom: 10, padding: "8px 12px", borderRadius: 8, background: "#f0faf4", border: "1px solid #b7e1c7", fontSize: 13 } }, v2NoticeText),
              v2ErrorMessages.length > 0 && react.createElement("div", { role: "alert", style: { color: "#be6262", marginBottom: 10, padding: "8px 12px", borderRadius: 8, background: "#fdf2f2", border: "1px solid #e6b8b8", fontSize: 13 } }, v2ErrorMessages.join("；")),
              !v2Loading && react.createElement("section", { "data-cabinet-entry-choice": "", style: { marginBottom: 16, padding: 14, border: '1px solid #d7dee6', borderRadius: 10 } },
                react.createElement("div", { role: 'group', 'aria-label': '选择内阁任务', style: { display: 'flex', gap: 10, marginBottom: 12 } },
                  react.createElement("button", { type: 'button', disabled: v2Saving || !v2ResumePreview?.taskId, 'aria-pressed': v2EntryChoice === 'resume', onClick: function () { v2SetEntryChoice('resume'); }, style: { padding: '8px 16px', borderRadius: 8, border: '1px solid #91acd5', background: v2EntryChoice === 'resume' ? '#edf3fd' : 'transparent', color: 'inherit', opacity: v2Saving || !v2ResumePreview?.taskId ? 0.45 : 1 } }, '接续此任务'),
                  react.createElement("button", { type: 'button', disabled: v2Saving || v2Loading, 'aria-pressed': v2EntryChoice === 'new', onClick: v2ChooseNewConfiguration, style: { padding: '8px 16px', borderRadius: 8, border: '1px solid #91acd5', background: v2EntryChoice === 'new' ? '#edf3fd' : 'transparent', color: 'inherit' } }, '新建独立任务'),
                  v2DetachTarget
                    ? react.createElement("button", { type: 'button', disabled: v2Saving || v2Loading || !v2CanDetach,
                      title: v2CanDetach ? '移除当前配置关联，保留讨论与成果' : '任务尚未结束，当前配置关联保留',
                      onClick: v2DetachConfiguration, style: { padding: '8px 16px', borderRadius: 8, border: '1px solid #d7dee6', background: 'transparent', color: 'inherit', opacity: v2Saving || v2Loading || !v2CanDetach ? 0.55 : 1 } }, '移除配置关联')
                    : react.createElement('span', { role: 'status', style: { padding: '8px 0', color: '#65717d', fontSize: 13 } }, v2FactReady ? '当前没有配置关联' : '当前配置读取失败，请刷新重试'),
                  react.createElement('button', { type: 'button', disabled: v2Saving || v2Loading, onClick: function () { return v2ReadConfiguration(); }, style: { padding: '8px 16px', borderRadius: 8, border: '1px solid #d7dee6', background: 'transparent', color: 'inherit' } }, '刷新任务面板')
                ),
                v2EntryChoice !== 'new' && v2ResumePreview && react.createElement("div", { style: { fontSize: 13, lineHeight: 1.7 } },
                  v2ResumePreview.kind === 'root-finalizing' && react.createElement('p', { style: { margin: '0 0 8px' } }, '各席成果已经交付，当前只需完成秘书最终总结。接续会沿用现有成果。'),
                  react.createElement("div", null, '已完成：' + ((v2ResumePreview?.completed || []).map(v2SeatPosition).join('；') || '暂无可核实的已完成席位')),
                  react.createElement("div", null, v2ResumeFault === 'TASK_STOPPED' ? '状态：已停止' : '故障：' + (v2ResumeFault || '无已记录故障')),
                  react.createElement("div", null, '预计下一席：' + v2SeatPosition(v2ResumePreview?.nextSeat)),
                  (v2ResumePreview?.legacyCandidates || []).length > 0 && react.createElement("div", null, '旧记录候选（仅查看）：' + v2ResumePreview.legacyCandidates.map(v2SeatPosition).join('；')),
                  (v2ResumePreview?.missing || []).length > 0 && react.createElement("div", { role: 'status', style: { color: '#be6262' } }, '接续前需要处理：' + v2ResumePreview.missing.join('；')),
                  v2ResumePreview.kind === 'root-finalizing' && v2ResumePreview.canChangeSecretaryModel && react.createElement('label', { style: { display: 'block', marginTop: 10 } },
                    '秘书模型（本次收尾） ',
                    react.createElement('select', { 'aria-label': '秘书收尾模型', value: v2SecretaryChoice, disabled: v2Saving || v2Loading,
                      onChange: function (event) { v2SetSecretaryChoice(event.target.value); }, style: { maxWidth: '100%', padding: '6px 8px' } },
                      react.createElement('option', { value: '' }, '沿用当前：' + [v2ResumePreview.secretaryModel?.providerName || v2ResumePreview.secretaryModel?.providerId, v2ResumePreview.secretaryModel?.displayName || v2ResumePreview.secretaryModel?.modelId].filter(Boolean).join(' / ')),
                      (v2Bridge.catalog()?.models || []).map(function (model) { return react.createElement('option', { key: JSON.stringify([model.providerId, model.modelId]), value: JSON.stringify([model.providerId, model.modelId]) }, (model.providerName || model.providerId) + ' / ' + (model.displayName || model.modelId)); })
                    )
                  )
                ),
                v2EntryChoice === 'new' && react.createElement('div', { style: { fontSize: 13, lineHeight: 1.7 } }, '使用下方排席新建独立任务；任务栏可留空，应用后在主对话发送本次需求。')
              ),
              v2EntryChoice === 'new' && v2DraftTask && react.createElement(CabinetV2ConfigEditor, { value: v2DraftTask, onChange: function (value) { v2SetDraftTask(value); v2SetNoticeText(""); }, disabled: v2Saving || v2Loading, context: "task" }),
              react.createElement(CabinetCompletedTasks, { sessionId, disabled: v2Saving || v2Loading, onBusyChange: v2SetSaving, onDeleted: v2AfterDeleted }),
              !v2Loading && react.createElement('details', { open: true, style: { marginTop: 14 } },
                react.createElement('summary', null, '本对话讨论历史'),
                v2HistoryState === 'error' && react.createElement('p', { role: 'alert' }, '讨论历史读取失败，请刷新任务面板重试。'),
                v2HistoryState === 'ready' && v2TaskHistory.length === 0 && react.createElement('p', null, '暂无任务讨论历史'),
                v2TaskHistory.map(function (task) {
                  var chipStyle = { padding: '4px 10px', borderRadius: 6, border: '1px solid #cdd8e5', background: 'var(--dsw-alias-bg-base, #fff)', color: '#3d609a', cursor: 'pointer', fontSize: 12 };
                  var openSub = function (cid) { v2SetModalOpen(false); cabinetV2Ui.openGroupConversation(cid); };
                  return react.createElement('div', { key: task.taskId, style: { padding: '10px 0', borderBottom: '1px solid #e8edf2' } },
                    react.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 6 } },
                      react.createElement('strong', { style: { fontSize: 13 } }, task.goal),
                      react.createElement('span', { style: { fontSize: 12, color: '#65717d', flexShrink: 0 } }, task.statusLabel || (task.completed ? '已结束' : '进行中'))
                    ),
                    react.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                      (task.groups || []).flatMap(function (group) {
                        var members = (group.members || []).length ? group.members : (group.nativeSessionId ? [{ childId: group.nativeSessionId, label: group.label }] : []);
                        return members.map(function (m) {
                          return react.createElement('button', { key: m.childId, type: 'button', disabled: v2Saving, style: chipStyle, onClick: function () { openSub(m.childId); } }, m.label || group.label);
                        });
                      }),
                      (task.verdicts || []).map(function (v) {
                        return react.createElement('button', { key: v.childId, type: 'button', disabled: v2Saving, style: { ...chipStyle, borderColor: '#d9b589', color: '#8a5514' }, onClick: function () { openSub(v.childId); } }, v.label || '审验裁决');
                      }),
                      task.secretary && task.secretary.childId && react.createElement('button', { key: task.secretary.childId, type: 'button', disabled: v2Saving, style: { ...chipStyle, borderColor: '#9ec5b2', color: '#2d7a55' }, onClick: function () { openSub(task.secretary.childId); } }, task.secretary.label || '秘书对话')
                    )
                  );
                })
              )
            ),
            react.createElement("footer", {
              style: {
                flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap",
                padding: "12px 22px", borderTop: "1px solid var(--dsw-alias-border-l3, #e8edf2)",
                background: "var(--dsw-alias-bg-base, #ffffff)"
              }
            },
              react.createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
                react.createElement("button", {
                  type: "button", disabled: v2Saving || v2Loading || v2EntryChoice !== 'new' || !v2DraftTask, onClick: v2PromoteToDefaultPlan,
                  style: { padding: "8px 14px", borderRadius: 8, border: "1px solid #91acd5", background: "#edf3fd", color: "#3d609a", cursor: "pointer", fontSize: 13, fontWeight: 600 }
                }, "一键设为默认配置"),
                react.createElement("button", {
                  type: "button", disabled: v2Saving || v2Loading || v2EntryChoice !== 'new', onClick: v2ReloadFromDefaultPlan,
                  style: { padding: "8px 14px", borderRadius: 8, border: "1px solid #d7dee6", background: "transparent", color: "#65717d", cursor: "pointer", fontSize: 13 }
                }, "载入全局默认")
              ),
              react.createElement("div", { style: { display: "flex", gap: 10 } },
                react.createElement("button", {
                  type: "button", disabled: v2Saving, onClick: v2CancelConfiguration,
                  style: { padding: "8px 18px", borderRadius: 8, border: "1px solid #d7dee6", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 14 }
                }, "取消"),
                react.createElement("button", {
                  type: "button", disabled: v2Saving || v2Loading || !v2FactReady || !v2EntryChoice || (v2EntryChoice === 'resume' ? !v2ResumePreview?.ok : !v2DraftTask), onClick: v2EntryChoice === 'resume' ? v2ContinueCheckpoint : v2ApplyConfiguration,
                  style: { padding: "8px 20px", borderRadius: 8, border: "1px solid #3d609a", background: "#3d609a", color: "#ffffff", cursor: "pointer", fontSize: 14, fontWeight: 600 }
                }, v2Saving ? "应用中…" : v2EntryChoice === 'resume' ? v2ResumePreview?.kind === 'root-finalizing' ? '仅补秘书总结' : "确认接续此任务" : v2EntryChoice === 'new' ? "新建独立任务" : "请选择任务")
              )
            )
          )
        ),
        document.body
      );
    }

// BEGIN CABINET DASHBOARD BUNDLE
function renderReaderBody({ H, readerState, collaboration, group, thread, activeTab, renderToolRow }) {
  if (readerState?.kind === 'history-report') {
    const reports = readerState.reports ?? [];
    if (!reports.length) return H('p', { style: { color: '#65717d' } }, '该历史任务暂无已保存的汇报记录。');
    return H('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
      reports.map((r, i) => H('article', { key: r.id || i, style: { padding: 14, borderRadius: 10, border: '1px solid #e3e8ee' } },
        H('div', { style: { fontWeight: 600, marginBottom: 8 } }, r.title || '内阁汇报'),
        H('div', { style: { whiteSpace: 'pre-wrap', lineHeight: 1.6, fontSize: 14 } }, r.text)
      ))
    );
  }

  if (readerState?.kind === 'report') {
    const reports = collaboration?.secretary?.reports ?? [];
    if (!reports.length) return H('p', { style: { color: '#65717d' } }, '暂无已生成的秘书报告。');
    return H('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
      reports.map((r, i) => H('article', { key: r.id || i, style: { padding: 14, borderRadius: 10, border: '1px solid #e3e8ee' } },
        H('div', { style: { fontWeight: 600, marginBottom: 8 } }, r.kind === 'final' ? '最终简述' : '阶段汇报'),
        H('div', { style: { whiteSpace: 'pre-wrap', lineHeight: 1.6, fontSize: 14 } }, r.text)
      ))
    );
  }

  if (readerState?.kind === 'deliverables') {
    const list = collaboration?.deliverables ?? [];
    if (!list.length) return H('p', { style: { color: '#65717d' } }, '当前尚无已定稿交付成果。');
    return H('div', { style: { display: 'flex', flexDirection: 'column', gap: 18 } },
      list.map((d, i) => H('article', { key: d.id || i, style: { padding: 16, borderRadius: 10, border: '1px solid #e3e8ee' } },
        H('h3', { style: { margin: '0 0 10px', fontSize: 16 } }, `交付版本 · ${d.version}`),
        d.designText && H('div', { style: { marginBottom: 12 } },
          H('strong', null, '设计方案'),
          H('div', { style: { whiteSpace: 'pre-wrap', marginTop: 6, lineHeight: 1.6 } }, d.designText)
        ),
        d.constructionText && H('div', null,
          H('strong', null, '施工成果'),
          H('div', { style: { whiteSpace: 'pre-wrap', marginTop: 6, lineHeight: 1.6 } }, d.constructionText)
        )
      ))
    );
  }
  return H('p', { style: { color: '#65717d' } }, '暂无可显示的内容。');
}

function CabinetReaderDialog({ readerState, snapshot, onClose }) {
  const H = react.createElement;
  const dialogRef = react.useRef(null);
  const collaboration = snapshot?.collaboration;

  react.useEffect(() => {
    const node = dialogRef.current;
    if (node && typeof node.showModal === 'function' && !node.open) { try { node.showModal(); } catch {} }
    return () => { if (node?.open) try { node.close(); } catch {} };
  }, []);

  const title = readerState?.kind === 'report' ? '秘书报告' : readerState?.kind === 'history-report' ? (readerState.title || '历史内阁汇报') : '交付成果';

  return react_dom.createPortal(
    H('dialog', {
      ref: dialogRef,
      'data-cabinet-reader-surface': '',
      onKeyDown: e => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } },
      style: {
        position: 'fixed', inset: 0, margin: 'auto', width: 'min(1040px, calc(100vw - 40px))',
        height: 'min(760px, calc(100dvh - 40px))', padding: 0, borderRadius: 14,
        border: '1px solid var(--dsw-alias-border-l2, #cdd8e5)',
        background: 'var(--dsw-alias-bg-base, #fff)', color: 'var(--dsw-alias-label-primary, #26313d)',
        boxShadow: '0 14px 40px rgba(0,0,0,0.16)'
      }
    },
      H('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } },
        H('header', {
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 22px', borderBottom: '1px solid var(--dsw-alias-border-l3, #e8edf2)' }
        },
          H('div', { style: { display: 'flex', alignItems: 'baseline', gap: 14 } },
            H('button', {
              type: 'button', onClick: onClose,
              style: { background: 'none', border: 0, color: '#3d609a', cursor: 'pointer', fontSize: 14, fontWeight: 500, padding: 0 }
            }, '← 返回主对话'),
            H('h2', { style: { margin: 0, fontSize: 19, fontWeight: 600 } }, title)
          )
        ),
        H('main', { style: { flex: 1, overflowY: 'auto', padding: '18px 24px' } },
          renderReaderBody({ H, readerState, collaboration })
        )
      )
    ),
    document.body
  );
}

function CabinetProgressBar({ color = 'neutral', id }) {
  const H = react.createElement;
  const bg = color === 'red' ? '#be6262' : color === 'green' ? '#589779' : color === 'yellow' ? '#f0e7cd' : '#e1e6ec';
  return H('div', {
    id,
    'data-cabinet-state-color': color,
    style: { width: '100%', height: 6, borderRadius: 3, background: bg, overflow: 'hidden', margin: '6px 0 8px' }
  },
    color === 'yellow' && H('span', {
      className: 'cabinet-activity-bar',
      style: { display: 'block', width: '36%', height: '100%', borderRadius: 3, background: '#c5a351' }
    })
  );
}

function CabinetInstructionPopover({ sessionId, groupKey, collaboration, onClose }) {
  const H = react.createElement;
  const bridge = globalThis.__dshCabinetV2;
  const [selector, setSelector] = react.useState(groupKey ? 'next' : 'current');
  const [participantId, setParticipantId] = react.useState('');
  const [text, setText] = react.useState('');
  const [sending, setSending] = react.useState(false);
  const [msg, setMsg] = react.useState('');

  const group = groupKey ? collaboration?.groups?.find(g => g.key === groupKey) : null;
  const members = group
    ? group.members
    : [
        ...(collaboration?.groups ?? []).flatMap(g => g.members ?? []),
        ...(collaboration?.independents ?? [])
      ];

  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    setMsg('');
    try {
      await bridge.groupCommand(sessionId, {
        action: 'queue-instruction',
        groupKey: groupKey || null,
        selector,
        participantId: selector === 'explicit' ? participantId : null,
        text: text.trim()
      });
      setText('');
      onClose?.();
    } catch (e) {
      setMsg(e.message || '发送未完成');
    } finally {
      setSending(false);
    }
  };

  return H('div', {
    'data-cabinet-instruction-box': '',
    style: {
      margin: '8px 0', padding: 10, borderRadius: 8,
      background: 'var(--dsw-alias-bg-base, #fff)', border: '1px solid #cdd8e5'
    }
  },
    H('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 } },
      H('strong', { style: { fontSize: 13 } }, group ? `${group.label} · 补充指令` : '主任务补充指令'),
      H('button', { type: 'button', onClick: onClose, style: { background: 'none', border: 0, cursor: 'pointer', color: '#65717d' } }, '×')
    ),
    H('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 } },
      [['current', '当前 AI'], ['next', '下一位 AI'], ['explicit', '指定成员']].map(([k, label]) =>
        H('button', {
          key: k, type: 'button', onClick: () => setSelector(k),
          style: {
            padding: '3px 8px', borderRadius: 12, fontSize: 12, cursor: 'pointer',
            border: selector === k ? '1px solid #91acd5' : '1px solid #d7dee6',
            background: selector === k ? '#edf3fd' : '#f1f4f7',
            color: selector === k ? '#3d609a' : '#26313d'
          }
        }, label)
      )
    ),
    selector === 'explicit' && H('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 } },
      members.map(m => H('button', {
        key: m.id, type: 'button', onClick: () => setParticipantId(m.id),
        style: {
          padding: '3px 8px', borderRadius: 12, fontSize: 12, cursor: 'pointer',
          border: participantId === m.id ? '1px solid #3d609a' : '1px solid #d7dee6',
          background: participantId === m.id ? '#dfeafb' : '#fff'
        }
      }, m.label))
    ),
    H('textarea', {
      rows: 2, value: text, onChange: e => setText(e.target.value),
      placeholder: '输入纠正或补充要求…',
      style: { width: '100%', boxSizing: 'border-box', padding: 6, borderRadius: 6, border: '1px solid #d7dee6', font: 'inherit', fontSize: 12 }
    }),
    msg && H('div', { style: { color: '#be6262', fontSize: 12, marginTop: 4 } }, msg),
    H('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 6 } },
      H('button', {
        type: 'button', disabled: sending || !text.trim(), onClick: send,
        style: { padding: '4px 12px', borderRadius: 6, border: '1px solid #91acd5', background: '#edf3fd', color: '#3d609a', cursor: 'pointer', fontSize: 12 }
      }, sending ? '发送中…' : '发送指令')
    )
  );
}

function CabinetDashboard({ sessionId, collapse }) {
  const H = react.createElement;
  const bridge = globalThis.__dshCabinetV2;
  const [, setTick] = react.useState(0);
  const [readerState, setReaderState] = react.useState(null);
  const [instructionScope, setInstructionScope] = react.useState(null);

  react.useEffect(() => {
    const update = () => setTick(n => n + 1);
    const off = bridge?.subscribe?.(update);
    bridge?.refresh?.(sessionId).catch(() => {});
    window.addEventListener('dsh-cabinet-v2-state', update);
    return () => {
      if (typeof off === 'function') off();
      window.removeEventListener('dsh-cabinet-v2-state', update);
    };
  }, [sessionId, bridge]);

  const snap = bridge?.snapshot?.(sessionId);
  const col = snap?.collaboration;
  const groups = col?.groups ?? [];
  const independents = col?.independents ?? [];
  const secretary = col?.secretary;
  const stoppedAll = !!col?.stoppedAll;

  const toggleGroupStop = async group => {
    if (group.stopped) return await bridge?.groupCommand?.(sessionId, { action: 'resume-group', groupKey: group.key });
    await bridge?.groupCommand?.(sessionId, { action: 'stop-group', groupKey: group.key });
  };

  const toggleAllStop = async () => {
    if (stoppedAll) return await bridge?.groupCommand?.(sessionId, { action: 'resume-all' });
    await bridge?.groupCommand?.(sessionId, { action: 'stop-all' });
  };

  const btnStyle = {
    padding: '5px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, #d7dee6)',
    background: 'var(--dsw-alias-bg-base, #fff)', color: 'inherit', fontSize: 12, cursor: 'pointer'
  };

  return H('aside', {
    'data-cabinet-dashboard': '',
    'data-cabinet-session-id': sessionId,
    style: { boxSizing: 'border-box', width: '100%', height: '100%', overflowY: 'auto', padding: '14px 14px', fontSize: 13, lineHeight: 1.45 }
  },
    H('style', null, '@keyframes cabinetSlide{from{transform:translateX(-120%)}to{transform:translateX(320%)}}.cabinet-activity-bar{animation:cabinetSlide 1.6s linear infinite}'),
    H('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } },
      H('strong', { style: { fontSize: 16 } }, '内阁'),
      H('div', { style: { display: 'flex', gap: 10 } },
        !snap?.readOnly && H('button', { type: 'button', onClick: () => globalThis.__dshCabinetV2Ui?.openTaskSettings?.(sessionId), style: { background: 'none', border: 0, color: '#3d609a', cursor: 'pointer', fontSize: 13, padding: 0 } }, '配置'),
        typeof collapse === 'function' && H('button', { type: 'button', onClick: collapse, style: { background: 'none', border: 0, color: '#65717d', cursor: 'pointer', fontSize: 13, padding: 0 } }, '收起')
      )
    ),
    H('div', { style: { fontSize: 14, fontWeight: 500, marginBottom: 2 } }, snap?.config?.goal || snap?.archivedTaskGoal || '当前会话任务'),
    H('div', { 'data-cabinet-n4-stage': '', style: { fontSize: 12, color: '#65717d', marginBottom: 12 } }, col?.stageLabel || '待命 · 在主对话发送任务自动启动'),

    col?.awaitingHumanApproval && H('div', {
      style: { padding: 10, marginBottom: 12, borderRadius: 10, background: '#edf3fd', border: '1px solid #91acd5', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }
    },
      H('span', { style: { fontSize: 12, fontWeight: 600, color: '#3d609a' } }, '设计方案待确认'),
      H('div', { style: { display: 'flex', gap: 6 } },
        H('button', { type: 'button', style: { ...btnStyle, color: '#3d609a', borderColor: '#91acd5' }, onClick: () => bridge?.groupCommand?.(sessionId, { action: 'approve-design' }) }, '认可此版'),
        H('button', { type: 'button', style: btnStyle, onClick: () => bridge?.groupCommand?.(sessionId, { action: 'reject-design' }) }, '退回修改')
      )
    ),

    groups.map(g => H('section', {
      key: g.key, 'data-cabinet-n4-group': g.key,
      style: { padding: 12, marginBottom: 12, borderRadius: 11, background: 'color-mix(in srgb, var(--dsw-alias-bg-base, #fff) 92%, #91acd5)', border: '1px solid var(--dsw-alias-border-l2, #c9d7ea)' }
    },
      H('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
        H('strong', { style: { fontSize: 14 } }, `${g.label} · ${g.members?.length || 2} 人`),
        H('span', { style: { fontSize: 12, color: '#65717d' } }, g.statusText)
      ),
      H(CabinetProgressBar, { color: g.color }),
      (g.members ?? []).map(m => H('div', { key: m.id, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, margin: '4px 0' } },
        m.nativeSessionId
          ? H('button', {
              type: 'button',
              title: '点击查看该席位独立子对话',
              onClick: () => globalThis.__dshCabinetV2Ui?.openGroupConversation?.(m.nativeSessionId),
              style: { background: 'none', border: 0, padding: 0, color: '#3d609a', cursor: 'pointer', fontSize: 12, textAlign: 'left', textDecoration: 'underline', textUnderlineOffset: 2 }
            }, `${m.kind === 'leader' ? '组长' : '组员'} · ${m.label}`)
          : H('span', null, `${m.kind === 'leader' ? '组长' : '组员'} · ${m.label}`),
        H('span', { style: { color: '#65717d' } }, m.statusText)
      )),
      g.reviewConclusion && H('div', { style: { fontSize: 12, color: g.reviewConclusion === 'pass' ? '#2d8f54' : '#be6262', marginTop: 4 } }, `审验：${g.reviewConclusion === 'pass' ? '已通过' : '退回修改'}`),
      H('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 } },
        H('button', {
          type: 'button', disabled: !g.nativeSessionId,
          'data-cabinet-open-group': g.key,
          style: { ...btnStyle, color: '#3d609a', opacity: g.nativeSessionId ? 1 : 0.55 },
          onClick: () => { if (g.nativeSessionId) globalThis.__dshCabinetV2Ui?.openGroupConversation?.(g.nativeSessionId); }
        }, g.nativeSessionId ? '打开组聊' : '等待开会'),
        !snap?.readOnly && H('button', { type: 'button', style: { ...btnStyle, color: '#3d609a' }, onClick: () => setInstructionScope(instructionScope === g.key ? null : g.key) }, '补充指令'),
        !snap?.readOnly && H('button', { type: 'button', style: btnStyle, onClick: () => toggleGroupStop(g) }, g.stopped ? '继续本组' : '停止本组')
      ),
      instructionScope === g.key && H(CabinetInstructionPopover, { sessionId, groupKey: g.key, collaboration: col, onClose: () => setInstructionScope(null) })
    )),
    renderDashboardFooter({ H, independents, secretary, instructionScope, setInstructionScope, sessionId, col, btnStyle, toggleAllStop, stoppedAll, setReaderState, readerState, snap, toggleGroupStop })
  );
}

function renderDashboardFooter({ H, independents, secretary, instructionScope, setInstructionScope, sessionId, col, btnStyle, toggleAllStop, stoppedAll, setReaderState, readerState, snap, toggleGroupStop }) {
  return H(react.Fragment, null,
    independents.map(ind => H('div', { key: ind.key, style: { marginBottom: 10 } },
      H('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 13 } },
        H('span', { style: { fontWeight: 500 } }, ind.label),
        H('span', { style: { fontSize: 12, color: '#65717d' } }, ind.statusText)
      ),
      H(CabinetProgressBar, { color: ind.color })
    )),

    secretary && H('section', { 'data-cabinet-n4-secretary': '', style: { paddingTop: 10, marginTop: 10, borderTop: '1px solid var(--dsw-alias-border-l3, #e0e6ed)' } },
      H('div', { style: { fontWeight: 600, fontSize: 14, marginBottom: 4 } }, secretary.label),
      H('div', { style: { fontSize: 12, color: secretary.color === 'red' ? '#a33' : '#65717d', marginBottom: 6, whiteSpace: 'pre-wrap' } }, secretary.latestBrief),
      secretary.error && H('div', { role: 'alert', style: { fontSize: 12, color: '#a33', marginBottom: 6, whiteSpace: 'pre-wrap' } }, typeof secretary.error === 'string' ? secretary.error : secretary.error.message),
      H('button', { type: 'button', disabled: !(secretary.reports || []).length, onClick: () => setReaderState({ kind: 'report' }), style: { background: 'none', border: 0, color: '#3d609a', cursor: 'pointer', fontSize: 13, padding: 0, opacity: (secretary.reports || []).length ? 1 : 0.5 } }, '阅读报告'),
      col.stage === 'finalizing-delivery' && !snap?.readOnly && H('button', { type: 'button', onClick: () => globalThis.__dshCabinetV2Ui?.openTaskSettings?.(sessionId), style: { background: 'none', border: 0, color: '#3d609a', cursor: 'pointer', fontSize: 13, marginLeft: 12, padding: 0 } }, '处理秘书总结')
    ),

    instructionScope === 'main' && H(CabinetInstructionPopover, { sessionId, groupKey: null, collaboration: col, onClose: () => setInstructionScope(null) }),

    !snap?.readOnly && Boolean(snap?.config) && H('div', { style: { display: 'flex', gap: 8, marginTop: 12 } },
      H('button', { type: 'button', style: { ...btnStyle, flex: 1 }, onClick: () => setInstructionScope(instructionScope === 'main' ? null : 'main') }, '主任务指令'),
      H('button', { type: 'button', style: { ...btnStyle, flex: 1 }, onClick: toggleAllStop }, stoppedAll ? '继续全部工作' : '停止全部工作')
    ),
    !snap?.readOnly && H('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 } },
      H('button', { type: 'button', onClick: () => setReaderState({ kind: 'deliverables' }), style: { background: 'none', border: 0, color: '#3d609a', cursor: 'pointer', fontSize: 13, padding: 0 } }, '交付成果'),
      snap?.mode === 'cabinet' && H('button', { type: 'button', onClick: () => bridge?.groupCommand?.(sessionId, { action: 'exit-cabinet' }), style: { background: 'none', border: 0, color: '#be6262', cursor: 'pointer', fontSize: 13, padding: 0 } }, '退出内阁')
    ),

    (snap?.history || []).length > 0 && H('section', { 'data-cabinet-history-list': '', style: { marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--dsw-alias-border-l3, #e0e6ed)' } },
      H('div', { style: { fontWeight: 600, fontSize: 13, marginBottom: 8 } }, `本对话内阁历史记录（${snap.history.length}）`),
      snap.history.map(item => H('details', {
        key: item.taskId,
        open: !col || snap.mode !== 'cabinet',
        style: { marginBottom: 8, padding: 8, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2, #d7dee6)', background: 'var(--dsw-alias-bg-base, #fff)' }
      },
        H('summary', { style: { cursor: 'pointer', fontSize: 12, fontWeight: 500, lineHeight: 1.4 } }, `${item.goal} · ${item.statusLabel || '历史记录'}`),
        H('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 } },
          (item.groups || []).flatMap(g => (g.members || []).map(m => H('button', {
            key: m.childId, type: 'button',
            style: { ...btnStyle, padding: '3px 8px', fontSize: 11, color: '#3d609a' },
            onClick: () => globalThis.__dshCabinetV2Ui?.openGroupConversation?.(m.childId)
          }, m.label || g.label))),
          (item.verdicts || []).map(v => H('button', {
            key: v.childId, type: 'button',
            style: { ...btnStyle, padding: '3px 8px', fontSize: 11, borderColor: '#d9b589', color: '#8a5514' },
            onClick: () => globalThis.__dshCabinetV2Ui?.openGroupConversation?.(v.childId)
          }, v.label || '审验裁决')),
          item.secretary?.childId && H('button', {
            type: 'button',
            style: { ...btnStyle, padding: '3px 8px', fontSize: 11, borderColor: '#9ec5b2', color: '#2d7a55' },
            onClick: () => globalThis.__dshCabinetV2Ui?.openGroupConversation?.(item.secretary.childId)
          }, item.secretary.label || '秘书对话'),
          (item.reports || []).length > 0 && H('button', {
            type: 'button',
            style: { ...btnStyle, padding: '3px 8px', fontSize: 11 },
            onClick: () => setReaderState({ kind: 'history-report', title: item.goal, reports: item.reports })
          }, `查看汇报（${item.reports.length}）`)
        )
      ))
    ),

    readerState && H(CabinetReaderDialog, {
      sessionId, readerState, snapshot: snap, onClose: () => setReaderState(null),
      onOpenInstruction: gKey => { setReaderState(null); setInstructionScope(gKey || 'main'); },
      onToggleGroupStop: toggleGroupStop
    })
  );
}
// END CABINET DASHBOARD BUNDLE

    function CabinetV2NativeSpeech({ node }) {
      const H = React.createElement;
      const entry = node.data.entry;
      if (!entry) return H('div', { 'data-cabinet-native-control': node.data.id, role: 'status', style: { padding: '6px 16px', fontSize: 12, color: '#65717d' } }, node.data.text || (node.data.status === 'queued' ? '已排给下一席' : node.data.status === 'stopped' ? '本组已停止' : '指令已记录'));
      let displayText = entry.text;
      let blockers = [];
      let formalReady = false;
      if (entry.phase === 'formal') {
        displayText = '';
        try {
          const raw = String(entry.text ?? '').trim();
          const block = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
          const formal = JSON.parse(block ? block[1] : raw);
          displayText = typeof formal?.text === 'string' ? formal.text.trim() : '';
          blockers = Array.isArray(formal?.blockers) ? formal.blockers.map(String).filter(text => text.trim()) : [];
          formalReady = formal?.ready === true && Boolean(displayText) && Array.isArray(formal.blockers) && blockers.length === 0;
        } catch {}
        if (!formalReady && blockers.length === 0) blockers = ['组长尚未确认可交付成果'];
      }
      const records = entry.toolRecords ?? [];
      const paths = [...new Set(records.map(record => record.fullPath || record.path || record.result?.fullPath || record.result?.path).filter(Boolean))];
      return H('article', {
        'data-cabinet-native-speech': entry.id,
        'data-cabinet-actor-id': entry.actorId,
        style: { padding: '12px 16px', margin: '8px 0', border: '1px solid var(--dsw-alias-border-l2, #d7dee6)', borderRadius: 10 }
      },
        H('header', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 8 } },
          H('strong', null, entry.actorLabel || entry.actorId),
          entry.roleLabel && H('span', { style: { fontSize: 12, color: '#65717d' } }, entry.roleLabel),
          entry.phase === 'member' && H('span', { style: { fontSize: 12, color: '#65717d' } }, `第 ${entry.discussionRound || entry.round} 轮`),
          entry.phase === 'formal' && H('span', { style: { fontSize: 12, color: formalReady ? '#2d8f54' : '#be6262' } }, formalReady ? '正式成果' : '交付受阻')
        ),
        displayText && H('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.65 } }, displayText),
        blockers.length > 0 && H('ul', { style: { paddingLeft: 20, margin: '8px 0 0', color: '#be6262', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, blockers.map((text, index) => H('li', { key: index }, text))),
        paths.length > 0 && H('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10, fontSize: 12, color: '#65717d' } },
          paths.map(file => H('code', { key: file, style: { overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' } }, file))
        ),
        records.length > 0 && H('details', { style: { marginTop: 10, fontSize: 12 } },
          H('summary', { style: { cursor: 'pointer', color: '#65717d' } }, '工具记录'),
          records.map((record, index) => H('div', { key: record.id || `${entry.id}-tool-${index}`, style: { marginTop: 8 } },
            H('strong', null, record.name || record.tool || '工具'),
            record.summary && H('span', null, ` · ${record.summary}`),
            record.output && H('pre', { style: { margin: '4px 0 0', maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, typeof record.output === 'string' ? record.output : JSON.stringify(record.output, null, 2))
          ))
        )
      );
    }

    function CabinetV2NativeUserPrompt({ node }) {
      const H = React.createElement;
      const data = node.data ?? {};
      const text = String(data.text ?? '').trim();
      if (!text) return null;
      return H('article', {
        'data-cabinet-native-user-prompt': data.id || node.id,
        style: {
          padding: '10px 14px',
          margin: '8px 0 8px auto',
          maxWidth: '85%',
          borderRadius: 10,
          background: 'var(--dsw-alias-bg-secondary, #f2f5f8)',
          border: '1px solid var(--dsw-alias-border-l2, #d7dee6)'
        }
      },
        H('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #65717d)', marginBottom: 4 } }, '内阁任务'),
        H('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.6 } }, text)
      );
    }

    function CabinetV2NativeRelay({ node }) {
      const H = React.createElement;
      const data = node.data ?? {};
      const source = data.source ?? data;
      const groupLabel = source.groupLabel || data.title || '';
      const actorLabel = source.actorLabel || data.title || '';
      const label = data.phase === 'cabinet-blocked' ? (data.title || '内阁流程暂停') : data.phase === 'final-delivery' ? '内阁最终交付成果' : source.groupKey ? `${groupLabel || '工作组'} · 组长正式成果`
        : (groupLabel === '秘书' || data.role === 'secretary') ? '秘书最终汇报'
        : `${actorLabel || groupLabel || '工作席'} · 正式成果`;
      const rawText = typeof data.text === 'string'
        ? data.text
        : (data.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
      const text = rawText.replace(/^【内阁历史归档 · [^\n]*】\n?/, '');
      return H('article', { 'data-cabinet-native-relay': data.messageId || data.id || node.id, style: { padding: '12px 16px', margin: '8px 0', border: '1px solid var(--dsw-alias-border-l2, #d7dee6)', borderRadius: 10 } },
        H('strong', null, label),
        H('div', { style: { marginTop: 8, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.65 } }, text)
      );
    }

    function CabinetV2NativeGroupControls({ nativeGroup, snapshot }) {
      const H = React.createElement;
      const bridge = globalThis.__dshCabinetV2;
      const [text, setText] = React.useState('');
      const [pending, setPending] = React.useState(false);
      const [notice, setNotice] = React.useState('');
      const [error, setError] = React.useState('');
      const parentSnapshot = bridge.snapshot(nativeGroup.parentSessionId);
      const collaboration = snapshot.collaboration || parentSnapshot.collaboration;
      const group = collaboration?.groups?.find(item => item.key === nativeGroup.groupKey);
      const runCommand = async command => {
        if (pending || snapshot.readOnly) return;
        setPending(true); setNotice(''); setError('');
        try {
          await bridge.groupCommand(nativeGroup.parentSessionId, { groupKey: nativeGroup.groupKey, taskId: nativeGroup.taskId, ...command });
          if (command.action === 'queue-instruction') { setText(''); setNotice('已排给下一席'); }
          else setNotice(command.action === 'stop-group' ? '本组已停止' : '本组继续工作');
        } catch (failure) { setError(failure.message || '操作未完成'); }
        finally { setPending(false); }
      };
      const buttonStyle = { padding: '4px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, #d7dee6)', background: 'var(--dsw-alias-bg-base, #fff)', color: 'inherit', font: 'inherit', fontSize: 12, cursor: 'pointer' };
      return H('section', { 'data-cabinet-native-group-controls': nativeGroup.groupKey, style: { padding: '8px 10px', marginBottom: 6, border: '1px solid var(--dsw-alias-border-l2, #d7dee6)', borderRadius: 8, fontSize: 12 } },
        H('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 } },
          H('span', null, `${nativeGroup.groupLabel || '组聊'}${group?.statusText ? ` · ${group.statusText}` : ''}`),
          H('button', { type: 'button', style: { ...buttonStyle, border: 0, color: '#3d609a' }, onClick: () => cabinetV2Ui.openGroupConversation(nativeGroup.parentSessionId) }, '回主对话')
        ),
        !snapshot.readOnly && H('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          H('input', { type: 'text', 'aria-label': '纠正给下一席', value: text, disabled: pending, placeholder: '纠正给下一席…', onChange: event => setText(event.target.value), onKeyDown: event => { if (event.key === 'Enter' && text.trim() && !event.nativeEvent?.isComposing) { event.preventDefault(); void runCommand({ action: 'queue-instruction', selector: 'next', text: text.trim() }); } }, style: { flex: 1, minWidth: 0, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, #d7dee6)', background: 'var(--dsw-alias-bg-base, #fff)', color: 'inherit', font: 'inherit' } }),
          H('button', { type: 'button', disabled: pending || !text.trim(), style: { ...buttonStyle, color: '#3d609a' }, onClick: () => runCommand({ action: 'queue-instruction', selector: 'next', text: text.trim() }) }, '排入'),
          H('button', { type: 'button', disabled: pending, style: buttonStyle, onClick: () => runCommand({ action: group?.stopped ? 'resume-group' : 'stop-group' }) }, group?.stopped ? '继续本组' : '停止本组')
        ),
        (notice || error) && H('div', { role: 'status', style: { marginTop: 5, color: error ? '#be6262' : '#65717d' } }, error || notice)
      );
    }

    function CabinetV2InputOverlay(props) {
      const bridge = globalThis.__dshCabinetV2;
      const [, update] = React.useState(0);
      React.useEffect(() => {
        const off = bridge.subscribe(() => update(value => value + 1));
        void bridge.refresh(props.sessionId).catch(() => {});
        return off;
      }, [props.sessionId]);
      const snapshot = bridge.snapshot(props.sessionId);
      if (snapshot.readOnly) return null;
      if (snapshot.nativeGroup) return React.createElement(CabinetV2TaskSettingsHost, { ...props, sessionId: snapshot.nativeGroup.parentSessionId });
      if (snapshot.mode === 'cabinet-group') return null;
      return React.createElement(CabinetV2TaskSettingsHost, props);
    }

    function CabinetV2NativeGroupDock(props) {
      const bridge = globalThis.__dshCabinetV2;
      const [, update] = React.useState(0);
      React.useEffect(() => {
        const off = bridge.subscribe(() => update(value => value + 1));
        void bridge.refresh(props.sessionId).catch(() => {});
        return off;
      }, [props.sessionId]);
      const snapshot = bridge.snapshot(props.sessionId);
      if (!snapshot.nativeGroup) return null;
      return React.createElement(CabinetV2NativeGroupControls, { key: props.sessionId, nativeGroup: snapshot.nativeGroup, snapshot });
    }

    function CabinetV2ComposerPill(props) {
      const H = React.createElement;
      const bridge = globalThis.__dshCabinetV2;
      const sessionId = props?.sessionId;
      const [, setTick] = React.useState(0);
      React.useEffect(() => {
        if (!bridge || !sessionId) return;
        const off = bridge.subscribe(snap => {
          if (!snap || snap.sessionId === sessionId) setTick(n => n + 1);
        });
        bridge.refresh(sessionId).catch(() => {});
        return off;
      }, [sessionId]);

      if (!sessionId || !bridge) return null;
      const snap = bridge.snapshot(sessionId);
      if (snap?.nativeGroup || snap?.mode === "cabinet-group") return null;

      const isCabinet = snap?.mode === "cabinet";
      const stage = snap?.collaboration?.stage || "";
      const isRunning = isCabinet && stage && stage !== "idle" && stage !== "awaiting-user-acceptance" && !stage.endsWith("-blocked") && !snap?.collaboration?.stoppedAll;
      const historyCount = (snap?.history || []).length;
      const dotColor = isRunning ? "#c5a351" : isCabinet ? "#2d8659" : historyCount > 0 ? "#3d609a" : "#9aa5b1";
      const textLabel = isRunning ? "内阁: 运行中"
        : isCabinet ? "内阁: 已开启"
        : historyCount > 0 ? ("内阁: 历史(" + historyCount + ")")
        : "内阁: 未开启";

      const handleClick = () => {
        if (isCabinet || historyCount > 0) {
          if (typeof cabinetV2Ui.openCabinetSidebar === "function") {
            cabinetV2Ui.openCabinetSidebar(sessionId);
          }
        }
        if (typeof cabinetV2Ui.openTaskSettings === "function") {
          cabinetV2Ui.openTaskSettings(sessionId);
        }
      };

      return H("button", {
        type: "button",
        "data-cabinet-composer-pill": "",
        title: isCabinet ? "内阁模式运行或待命中，点击查看配置与讨论历史" : historyCount > 0 ? "本对话有内阁历史记录，点击查看历史子会话或新建内阁任务" : "点击为当前对话配置并开启内阁多模型模式",
        onClick: handleClick,
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          height: 26,
          padding: "0 9px",
          borderRadius: 999,
          border: "1px solid var(--dsw-alias-border-l2, #d7dee6)",
          background: isCabinet ? "rgba(61, 96, 154, 0.10)" : "transparent",
          color: "var(--dsw-alias-label-primary, inherit)",
          fontSize: 12,
          lineHeight: 1,
          cursor: "pointer",
          whiteSpace: "nowrap"
        }
      },
        H("span", { style: { width: 6, height: 6, borderRadius: "50%", background: dotColor, flexShrink: 0 } }),
        H("span", null, textLabel)
      );
    }

    function apply(ctx) {
      installStyles();
      const nativeDisposers = [];
      const nativeSpeechKind = "cabinet-v2-speech";
      const nativeSpeechRecord = "plugin:cabinet-v2/speech";
      const nativeRelayKind = "cabinet-v2-relay";
      const nativeUserPromptKind = "cabinet-v2-user-prompt";
      const nativeTabId = "dsh-cabinet";

      const safeReg = (label, fn) => {
        try {
          const d = fn();
          if (typeof d === "function") nativeDisposers.push(d);
          else if (d && typeof d.dispose === "function") nativeDisposers.push(() => d.dispose());
        } catch (err) {
          console.warn("[dsh-cabinet] isolated registration skipped (" + label + "):", err);
        }
      };

      const withService = (svcName, fn) => {
        const direct = (typeof ctx.get === "function" ? ctx.get(svcName) : null) || ctx[svcName];
        if (direct) {
          safeReg("service:" + svcName, () => fn(direct, ctx));
          return;
        }
        if (typeof ctx.inject === "function") {
          safeReg("inject:" + svcName, () => ctx.inject([svcName], scoped => {
            const svc = (typeof scoped.get === "function" ? scoped.get(svcName) : null) || scoped[svcName];
            if (svc) safeReg("service-delayed:" + svcName, () => fn(svc, scoped));
          }));
        }
      };

      const COMPOSER_LEFT_SLOT = "conversation.input.left";

      // 1. 显性主入口：主输入框工具栏药丸（与手册、人格并排，不依赖单一二级菜单）
      safeReg("slot:" + COMPOSER_LEFT_SLOT, () =>
        ctx.slots.inject(COMPOSER_LEFT_SLOT, () =>
          ctx.slots.register({ name: COMPOSER_LEFT_SLOT, id: "dsh-cabinet-composer-pill", order: 32 }, CabinetV2ComposerPill)
        )
      );

      // 2. 配置弹窗宿主（独立挂载，不依赖模型菜单是否存在）
      safeReg("slot:" + INPUT_OVERLAY_SLOT, () =>
        ctx.slots.inject(INPUT_OVERLAY_SLOT, () =>
          ctx.slots.register({ name: INPUT_OVERLAY_SLOT, id: "dsh-cabinet-task-settings", order: 100 }, CabinetV2InputOverlay)
        )
      );

      // 3. 兼容入口：模型下拉菜单选项
      safeReg("slot:" + MODEL_OPTIONS_SLOT, () =>
        ctx.slots.inject(MODEL_OPTIONS_SLOT, () =>
          ctx.slots.register({ name: MODEL_OPTIONS_SLOT, id: "dsh-cabinet-mode", order: 100, label: () => "内阁模式" }, CabinetV2ModeOption)
        )
      );

      // 4. 左侧设置页母本配置入口（独立隔离）
      if (typeof window.__CabinetCanvasEditor === "undefined") {
        safeReg("slot:" + SETTINGS_ICON_SLOT, () =>
          ctx.slots.inject(SETTINGS_ICON_SLOT, () =>
            ctx.slots.register({ name: SETTINGS_ICON_SLOT, id: SETTINGS_ENTRY_ID, order: SETTINGS_ORDER, label: () => "内阁模式" }, SettingsNavIcon)
          )
        );
        safeReg("slot:" + SETTINGS_SLOT, () =>
          ctx.slots.inject(SETTINGS_SLOT, () =>
            ctx.slots.register({ name: SETTINGS_SLOT, id: SETTINGS_ENTRY_ID, order: SETTINGS_ORDER, label: () => "内阁模式" }, CabinetSettingsPage)
          )
        );
      }

      // 5. 插件管理说明卡片
      safeReg("slot:plugins.bundle.config", () =>
        ctx.slots.inject("plugins.bundle.config", () =>
          ctx.slots.register({ name: "plugins.bundle.config", key: PACKAGE_ID, label: () => "内阁模式" }, function () {
            return React.createElement("p", { style: { margin: 0, fontSize: 13, color: "var(--dsw-alias-label-secondary)" } }, "内阁模式已就绪。可在主输入框下方点击「内阁」按钮、右下角模型菜单或左侧「内阁模式」设置页配置与查看历史。");
          })
        )
      );

      // 6. 主对话卡片渲染器（逐项独立隔离）
      safeReg("slot:chat-node-user-prompt", () =>
        ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({ name: "conversation.chat.node", key: nativeUserPromptKind }, CabinetV2NativeUserPrompt))
      );
      safeReg("slot:chat-node-speech", () =>
        ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({ name: "conversation.chat.node", key: nativeSpeechKind }, CabinetV2NativeSpeech))
      );
      safeReg("slot:chat-node-relay", () =>
        ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({ name: "conversation.chat.node", key: nativeRelayKind }, CabinetV2NativeRelay))
      );
      safeReg("slot:input-dock", () =>
        ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({ name: "conversation.input.dock", id: "dsh-cabinet-group-controls", order: 100 }, CabinetV2NativeGroupDock))
      );
      safeReg("slot:sidebar-right-tab", () =>
        ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name: "sidebar.right.pane.tab", key: nativeTabId }, CabinetDashboard))
      );

      // 7. 可选服务按需动态接入（某个服务未来改名不会连累整包停摆）
      withService("uiWorkspace", ws => {
        const openNativeSession = sessionId => ws.openSession(sessionId);
        cabinetV2Ui.openGroupConversation = openNativeSession;
        return () => {
          if (cabinetV2Ui.openGroupConversation === openNativeSession) delete cabinetV2Ui.openGroupConversation;
        };
      });

      withService("uiConversation", uiConv => {
        const localDisposers = [];
        const add = d => { if (typeof d === "function") localDisposers.push(d); };
        add(uiConv.events.register({
          kind: nativeUserPromptKind, target: "chat",
          match: {
            "plugin:cabinet-v2/user-prompt": event => ({ id: String(event.data?.id || event.seq), role: "start", exclusive: true })
          },
          start: (_context, match) => ({ ...match.event.data, seq: match.event.seq, time: match.event.time }),
          update: context => context.state,
          buildViewNode: context => context.state ? { key: context.key, kind: nativeUserPromptKind, id: context.id, target: "chat", anchorSeq: context.state.seq, location: context.start?.location ?? { kind: "unresolved" }, visibility: "visible", groupTree: "input", data: context.state } : null
        }));
        add(uiConv.events.register({
          kind: nativeSpeechKind, target: "chat",
          match: {
            [nativeSpeechRecord]: event => ({ id: event.data.entry.id || event.data.entry.turnId, role: "start", exclusive: true }),
            "plugin:cabinet-v2/control": event => ({ id: event.data.id, role: "start", exclusive: true })
          },
          start: (_context, match) => ({ ...match.event.data, seq: match.event.seq, time: match.event.time }),
          update: context => context.state,
          buildViewNode: context => context.state ? { key: context.key, kind: nativeSpeechKind, id: context.id, target: "chat", anchorSeq: context.state.seq, location: context.start?.location ?? { kind: "unresolved" }, visibility: "visible", data: context.state } : null
        }));
        add(uiConv.events.register({
          kind: nativeRelayKind, target: "chat",
          match: {
            "plugin:cabinet-v2/presentation": event => ({ id: String(event.data?.messageId || event.seq), role: "start", exclusive: true }),
            "user/message": event => event.data.source?.kind === "cabinet-relay" ? { id: String(event.data.id), role: "start", exclusive: true } : null
          },
          start: (_context, match) => ({ ...match.event.data, seq: match.event.seq, time: match.event.time }),
          update: context => context.state,
          buildViewNode: context => context.state ? { key: context.key, kind: nativeRelayKind, id: context.id, target: "chat", anchorSeq: context.state.seq, location: context.start?.location ?? { kind: "unresolved" }, visibility: "visible", data: context.state } : null
        }));
        return () => { for (const d of localDisposers.reverse()) { try { d(); } catch {} } };
      });

      withService("sidebarRightTabs", tabs =>
        tabs.register({ id: nativeTabId, kind: "dsh-cabinet", title: () => "内阁", guide: [{ id: "dsh-cabinet-status", order: 0, title: () => "内阁进度", description: () => "查看各组进度与历史记录，点击打开组聊" }] })
      );

      withService("sidebarRight", sr => {
        const opened = new Set();
        const openTab = sid => { try { sr.openTabIn(sid, nativeTabId); } catch {} };
        cabinetV2Ui.openCabinetSidebar = openTab;
        const offSub = globalThis.__dshCabinetV2.subscribe(snapshot => {
          if (snapshot.mode === "cabinet" && snapshot.collaboration && !opened.has(snapshot.sessionId)) {
            opened.add(snapshot.sessionId);
            openTab(snapshot.sessionId);
          }
        });
        return () => {
          try { offSub(); } catch {}
          if (cabinetV2Ui.openCabinetSidebar === openTab) delete cabinetV2Ui.openCabinetSidebar;
        };
      });

      return () => {
        for (const dispose of nativeDisposers.reverse()) { try { dispose(); } catch {} }
      };
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});

