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






