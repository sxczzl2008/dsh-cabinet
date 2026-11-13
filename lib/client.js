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
  if (/huihui/i.test(raw)) return 'Huihui';
  if (/sc117/i.test(raw)) return 'SC117';
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
    var VERSION = "0.1.1";
    var SETTINGS_SLOT = "settings.section";
    var SETTINGS_ICON_SLOT = "settings.section.icon";
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
      return renderSettingsContent({ H, VERSION, REPO_URL, GITHUB_ICON_PATH, revision, runtimeInfo, error, notice, draft, setDraft, setNotice, Editor, busy, saveMasterPlan, resetBlankMaster, load });
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
            H("button", { type: "button", className: "dcab-btn dcab-btn--quiet", disabled: p.busy, onClick: p.load }, "重新读取已保存母本")
          )
        ),

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

    function apply(ctx) {
      installStyles();
      try {
        if (!window.__cabinetSettingsSectionRegistered && typeof window.__CabinetCanvasEditor === "undefined") {
          window.__cabinetSettingsSectionRegistered = true;
          ctx.slots.inject(SETTINGS_ICON_SLOT, function () {
            return ctx.slots.register({ name: SETTINGS_ICON_SLOT, id: SETTINGS_ENTRY_ID, order: SETTINGS_ORDER, label: function () { return "内阁模式"; } }, SettingsNavIcon);
          });
          ctx.slots.inject(SETTINGS_SLOT, function () {
            return ctx.slots.register({ name: SETTINGS_SLOT, id: SETTINGS_ENTRY_ID, order: SETTINGS_ORDER, label: function () { return "内阁模式"; } }, CabinetSettingsPage);
          });
        }
        ctx.slots.inject("plugins.bundle.config", function () {
          return ctx.slots.register({ name: "plugins.bundle.config", key: PACKAGE_ID, label: function () { return "内阁模式"; } }, function () {
            return React.createElement("p", { style: { margin: 0, fontSize: 13, color: "var(--dsw-alias-label-secondary)" } }, "内阁模式已就绪。请在左侧「内阁模式」设置页配置全局默认方案，或在对话右下角模型下拉菜单中选择「内阁模式」启动。");
          });
        });
      } catch (e) {
        console.error("[dsh-cabinet] slot registration error:", e);
      }
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});

