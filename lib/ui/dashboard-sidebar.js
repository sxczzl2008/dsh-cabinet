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
  const [selector, setSelector] = react.useState('current');
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
    await bridge?.groupCommand?.(sessionId, { action: group.stopped ? 'resume-group' : 'stop-group', groupKey: group.key });
  };

  const toggleAllStop = async () => {
    await bridge?.groupCommand?.(sessionId, { action: stoppedAll ? 'resume-all' : 'stop-all' });
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
        H('button', { type: 'button', onClick: () => globalThis.__dshCabinetV2Ui?.openTaskSettings?.(sessionId), style: { background: 'none', border: 0, color: '#3d609a', cursor: 'pointer', fontSize: 13, padding: 0 } }, '配置'),
        typeof collapse === 'function' && H('button', { type: 'button', onClick: collapse, style: { background: 'none', border: 0, color: '#65717d', cursor: 'pointer', fontSize: 13, padding: 0 } }, '收起')
      )
    ),
    H('div', { style: { fontSize: 14, fontWeight: 500, marginBottom: 2 } }, snap?.config?.goal || '当前会话任务'),
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
      (g.members ?? []).map(m => H('div', { key: m.id, style: { display: 'flex', justifyContent: 'space-between', fontSize: 12, margin: '4px 0' } },
        H('span', null, `${m.kind === 'leader' ? '组长' : '组员'} · ${m.label}`),
        H('span', { style: { color: '#65717d' } }, m.statusText)
      )),
      g.reviewConclusion && H('div', { style: { fontSize: 12, color: g.reviewConclusion === 'pass' ? '#2d8f54' : '#be6262', marginTop: 4 } }, `审验：${g.reviewConclusion === 'pass' ? '已通过' : '退回修改'}`),
      H('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 } },
        H('button', { type: 'button', style: { ...btnStyle, color: '#3d609a' }, onClick: () => setReaderState({ kind: 'group', groupKey: g.key }) }, '查看讨论'),
        H('button', { type: 'button', style: { ...btnStyle, color: '#3d609a' }, onClick: () => setInstructionScope(instructionScope === g.key ? null : g.key) }, '补充指令'),
        H('button', { type: 'button', style: btnStyle, onClick: () => toggleGroupStop(g) }, g.stopped ? '继续本组' : '停止本组')
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
      H('div', { style: { fontSize: 12, color: '#65717d', marginBottom: 6, whiteSpace: 'pre-wrap' } }, secretary.latestBrief),
      H('button', { type: 'button', onClick: () => setReaderState({ kind: 'report' }), style: { background: 'none', border: 0, color: '#3d609a', cursor: 'pointer', fontSize: 13, padding: 0 } }, '阅读报告')
    ),

    instructionScope === 'main' && H(CabinetInstructionPopover, { sessionId, groupKey: null, collaboration: col, onClose: () => setInstructionScope(null) }),

    H('div', { style: { display: 'flex', gap: 8, marginTop: 12 } },
      H('button', { type: 'button', style: { ...btnStyle, flex: 1 }, onClick: () => setInstructionScope(instructionScope === 'main' ? null : 'main') }, '主任务指令'),
      H('button', { type: 'button', style: { ...btnStyle, flex: 1 }, onClick: toggleAllStop }, stoppedAll ? '继续全部工作' : '停止全部工作')
    ),
    H('div', { style: { marginTop: 10 } },
      H('button', { type: 'button', onClick: () => setReaderState({ kind: 'deliverables' }), style: { background: 'none', border: 0, color: '#3d609a', cursor: 'pointer', fontSize: 13, padding: 0 } }, '交付成果')
    ),

    readerState && H(CabinetReaderDialog, {
      sessionId, readerState, snapshot: snap, onClose: () => setReaderState(null),
      onOpenInstruction: gKey => { setReaderState(null); setInstructionScope(gKey || 'main'); },
      onToggleGroupStop: toggleGroupStop
    })
  );
}

