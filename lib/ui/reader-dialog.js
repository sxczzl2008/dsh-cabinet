function renderReaderBody({ H, readerState, collaboration, group, thread, activeTab, renderToolRow }) {
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
    if (!list.length && !group?.formalText) return H('p', { style: { color: '#65717d' } }, '当前尚无已定稿交付成果。');
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

  if (activeTab === 'materials') {
    return H('div', { style: { lineHeight: 1.6 } },
      H('h4', { style: { margin: '0 0 8px' } }, '本轮输入与前序定稿'),
      H('div', { style: { whiteSpace: 'pre-wrap', padding: 12, borderRadius: 8, background: '#f5f7fa' } },
        group?.formalText || collaboration?.deliverables?.slice(-1)?.[0]?.designText || '当前使用主对话任务目标作为输入材料。'
      )
    );
  }

  if (activeTab === 'files') {
    const tools = (thread?.rounds ?? []).flatMap(r => (r.messages ?? []).flatMap(m => m.toolRecords ?? []));
    const paths = [...new Set(tools.map(t => t.path).filter(Boolean))];
    return H('div', null,
      H('h4', { style: { margin: '0 0 10px' } }, '本组涉及的工作区文件'),
      paths.length
        ? H('ul', { style: { paddingLeft: 18, lineHeight: 1.8 } }, paths.map(p => H('li', { key: p }, p)))
        : H('p', { style: { color: '#65717d' } }, '本轮尚未读写外部文件。')
    );
  }

  if (activeTab === 'sources') {
    const origs = (collaboration?.originals ?? []).filter(o => !group?.key || o.groupKey === group.key);
    return H('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
      origs.map((o, idx) => H('details', { key: o.sourceId || idx, style: { padding: 10, borderRadius: 8, border: '1px solid #e3e8ee' } },
        H('summary', { style: { cursor: 'pointer', fontWeight: 500 } }, `${o.actorLabel || o.actorId} · ${o.roleBadge || o.role}`),
        H('pre', { style: { whiteSpace: 'pre-wrap', fontSize: 12, marginTop: 8 } }, o.text)
      ))
    );
  }

  const rounds = thread?.rounds ?? [];
  const allMessages = rounds.flatMap(r => (r.messages ?? []).map(m => ({ ...m, roundTitle: r.title })));
  if (!allMessages.length) {
    return H('p', { style: { color: '#65717d' } }, '本组讨论即将开始…');
  }

  return H('div', { style: { display: 'flex', flexDirection: 'column', gap: 18 } },
    rounds.map(r => H('section', { key: r.round },
      rounds.length > 1 && H('div', { style: { fontSize: 12, color: '#65717d', margin: '4px 0 10px', fontWeight: 600 } }, `${r.title}${r.subtitle ? ` · ${r.subtitle}` : ''}`),
      (r.messages ?? []).map((msg, idx) => H('article', {
        key: msg.id || idx,
        'data-cabinet-group-event': msg.id || idx,
        style: { paddingBottom: 14, marginBottom: 14, borderBottom: '1px solid var(--dsw-alias-border-l3, #edf0f4)' }
      },
        H('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 } },
          H('strong', { style: { fontSize: 15 } }, msg.actorLabel || msg.actorId),
          H('span', { style: { fontSize: 13, color: '#65717d' } }, msg.roleLabel || '')
        ),
        H('div', { style: { whiteSpace: 'pre-wrap', lineHeight: 1.6, fontSize: 14 } }, msg.text),
        Array.isArray(msg.toolRecords) && msg.toolRecords.map((tr, tIdx) => renderToolRow(`${msg.id || idx}-${tIdx}`, { ...tr, id: `${msg.id || idx}-${tIdx}` }))
      ))
    ))
  );
}

function CabinetReaderDialog({ sessionId, readerState, snapshot, onClose, onOpenInstruction, onToggleGroupStop }) {
  const H = react.createElement;
  const bridge = globalThis.__dshCabinetV2;
  const dialogRef = react.useRef(null);
  const mainRef = react.useRef(null);
  const [thread, setThread] = react.useState(null);
  const [activeTab, setActiveTab] = react.useState('discussion');
  const [expandedTools, setExpandedTools] = react.useState({});
  const [hasNewMsg, setHasNewMsg] = react.useState(false);
  const prevMsgCount = react.useRef(0);

  const collaboration = snapshot?.collaboration;
  const groupKey = readerState?.groupKey;
  const group = collaboration?.groups?.find(g => g.key === groupKey);

  react.useEffect(() => {
    const node = dialogRef.current;
    if (node && typeof node.showModal === 'function' && !node.open) { try { node.showModal(); } catch {} }
    return () => { if (node?.open) try { node.close(); } catch {} };
  }, []);

  const loadGroupThread = react.useCallback(async () => {
    if (!groupKey || !bridge?.readGroupConversation) return;
    try {
      const res = await bridge.readGroupConversation(sessionId, groupKey);
      if (res?.conversation) {
        const count = (res.conversation.rounds ?? []).reduce((acc, r) => acc + (r.messages?.length ?? 0), 0);
        const el = mainRef.current;
        const nearBottom = !el || (el.scrollHeight - el.scrollTop - el.clientHeight < 60);
        if (prevMsgCount.current > 0 && count > prevMsgCount.current && !nearBottom) setHasNewMsg(true);
        prevMsgCount.current = count;
        setThread(res.conversation);
      }
    } catch {}
  }, [sessionId, groupKey, bridge]);

  react.useEffect(() => { loadGroupThread(); }, [loadGroupThread, snapshot?.sourceSeq]);

  const scrollToLatest = () => {
    mainRef.current?.scrollTo({ top: mainRef.current.scrollHeight, behavior: 'smooth' });
    setHasNewMsg(false);
  };

  const title = readerState?.kind === 'report' ? '秘书报告' : readerState?.kind === 'deliverables' ? '交付成果' : (group?.label || thread?.label || '工作组讨论');
  const subtitle = readerState?.kind === 'group' ? `第 ${group?.round || thread?.currentRound || 1} 轮 · ${group?.role === 'design' ? '设计方案' : group?.role === 'construction' ? '工程施工' : '审验检查'}` : '';

  const renderToolRow = (key, tr) => {
    const open = !!expandedTools[key];
    const toolLabel = ({
      read_file: '文件读取', write_file: '文件写入',
      edit_file: '文件修改', list_files: '目录扫描', search_text: '代码检索', run_command: '命令执行'
    })[tr.name] || tr.name;

    return H('div', {
      key,
      style: { margin: '8px 0', padding: '10px 14px', borderRadius: 8, background: 'var(--dsw-alias-bg-l1, #f5f7fa)', border: '1px solid var(--dsw-alias-border-l3, #e3e8ee)' }
    },
      H('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, fontSize: 13 } },
        H('span', { style: { fontWeight: 500 } }, `${toolLabel}${tr.path ? ` · ${tr.path}` : ''}`),
        H('span', { style: { color: '#65717d' } }, tr.status || '已完成'),
        H('button', {
          type: 'button',
          onClick: () => setExpandedTools(prev => ({ ...prev, [key]: !prev[key] })),
          style: { background: 'none', border: 0, color: '#3d609a', cursor: 'pointer', fontSize: 13, padding: 0 }
        }, open ? '收起结果' : '查看结果')
      ),
      open && tr.output && H('pre', {
        style: { margin: '8px 0 0', padding: 10, borderRadius: 6, fontSize: 12, background: 'var(--dsw-alias-bg-base, #fff)', overflow: 'auto', maxHeight: 260, whiteSpace: 'pre-wrap' }
      }, tr.output)
    );
  };

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
            H('h2', { style: { margin: 0, fontSize: 19, fontWeight: 600 } }, title),
            subtitle && H('span', { style: { fontSize: 13, color: '#65717d' } }, subtitle)
          ),
          group && H('div', { style: { display: 'flex', gap: 10 } },
            H('button', {
              type: 'button', onClick: () => onOpenInstruction?.(group.key),
              style: { padding: '6px 14px', borderRadius: 8, border: '1px solid #d7dee6', background: '#f1f4f7', cursor: 'pointer', fontSize: 13 }
            }, '补充指令'),
            H('button', {
              type: 'button', onClick: () => onToggleGroupStop?.(group),
              style: { padding: '6px 14px', borderRadius: 8, border: '1px solid #d7dee6', background: '#fff', cursor: 'pointer', fontSize: 13 }
            }, group.stopped ? '继续本组' : '停止本组')
          )
        ),
        H('main', { ref: mainRef, style: { flex: 1, overflowY: 'auto', padding: '18px 24px' } },
          renderReaderBody({ H, readerState, collaboration, group, thread, activeTab, renderToolRow })
        ),
        readerState?.kind === 'group' && H('footer', {
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 24px', borderTop: '1px solid var(--dsw-alias-border-l3, #e8edf2)', fontSize: 13 }
        },
          H('div', { style: { display: 'flex', gap: 12 } },
            [['discussion', '讨论记录'], ['materials', '本轮材料'], ['files', '关联文件'], ['sources', '原文与来源']].map(([k, label]) =>
              H('button', {
                key: k, type: 'button', onClick: () => setActiveTab(k),
                style: {
                  padding: '5px 12px', borderRadius: 7, cursor: 'pointer', fontSize: 13,
                  border: activeTab === k ? '1px solid #91acd5' : '1px solid transparent',
                  background: activeTab === k ? '#edf3fd' : 'transparent',
                  color: activeTab === k ? '#3d609a' : '#65717d'
                }
              }, label)
            )
          ),
          hasNewMsg && H('button', {
            type: 'button', onClick: scrollToLatest,
            style: { background: 'none', border: 0, color: '#3d609a', cursor: 'pointer', fontSize: 13 }
          }, '有新消息 · 查看')
        )
      )
    ),
    document.body
  );
}
