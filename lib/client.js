window.__ModuleLoader__.load({
  id: 'dsh-self-improvement/client',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')

    const BRAND = 'var(--dsw-alias-brand-primary,#4d6bfe)'
    const WARN = 'var(--dsw-alias-state-warn-primary,#d97706)'
    const ERR = 'var(--dsw-alias-state-error-primary,#dc2626)'
    const OK = 'var(--dsw-alias-state-success-primary,#16a34a)'

    const CSS = [
      '.sipx-shell{--fg:var(--dsw-alias-label-primary,#1f2328);--fg2:var(--dsw-alias-label-secondary,#6b7280);--line:var(--dsw-alias-border-l1,rgba(128,128,128,.16));--line2:var(--dsw-alias-border-l2,rgba(128,128,128,.28));--l1:var(--dsw-alias-bg-layer-1,#fff);--l2:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.05));color:var(--fg);font-size:12.5px;line-height:1.6;background:var(--l1);border:1px solid var(--line);border-radius:14px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.04)}',
      '.sipx-shell.sipx-drawer{position:fixed;right:12px;top:56px;bottom:12px;width:340px;max-width:36vw;z-index:55;display:flex;flex-direction:column;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.14),0 2px 8px rgba(0,0,0,.06)}',
      '.sipx-shell.sipx-float{position:fixed;right:12px;top:56px;width:330px;max-width:calc(100vw - 24px);z-index:60;max-height:74vh;display:flex;flex-direction:column;border-radius:16px;box-shadow:0 14px 44px rgba(0,0,0,.18)}',
      '.sipx-fold{display:inline-block}',
      '.sipx-head{display:flex;align-items:center;gap:7px;padding:11px 13px 9px;flex:0 0 auto;flex-wrap:wrap;row-gap:4px}',
      '.sipx-mark{width:18px;height:18px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;background:' + BRAND + ';color:#fff;font-size:10px;font-weight:700;box-shadow:0 0 0 3px color-mix(in srgb,' + BRAND + ' 16%,transparent)}',
      '.sipx-eyebrow{flex:0 0 auto;font-size:9.5px;font-weight:600;letter-spacing:.1em;color:var(--fg2);white-space:nowrap}',
      '.sipx-title{flex:0 0 auto;font-weight:650;font-size:13px;white-space:nowrap}',
      '.sipx-spacer{flex:1;min-width:4px}',
      '.sipx-dot{width:6px;height:6px;border-radius:50%;background:var(--line2);flex:0 0 auto}',
      '.sipx-dot.alert{background:' + WARN + ';box-shadow:0 0 0 3px color-mix(in srgb,' + WARN + ' 20%,transparent)}',
      '.sipx-count{color:var(--fg2);font-size:11.5px;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.sipx-brandrow{display:flex;align-items:baseline;gap:6px;min-width:0;overflow:hidden}',
      '.sipx-chip{flex:0 0 auto;display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:999px;border:1px solid var(--line);background:var(--l2);color:var(--fg2);font-size:11px;white-space:nowrap}',
      '.sipx-icon{width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:8px;background:transparent;color:var(--fg2);cursor:pointer;font-size:12px;line-height:1}',
      '.sipx-icon:hover{background:var(--l2);color:var(--fg)}',
      '.sipx-body{overflow:auto;padding:2px 10px 12px;flex:1 1 auto;scrollbar-width:thin}',
      '.sipx-stack{display:flex;flex-direction:column;gap:9px}',
      '.sipx-warnnote{display:flex;align-items:flex-start;gap:7px;margin:0 10px 8px;padding:8px 9px;border-radius:10px;border:1px solid color-mix(in srgb,' + WARN + ' 45%,transparent);background:color-mix(in srgb,' + WARN + ' 12%,transparent);color:var(--fg);font-size:11.5px;line-height:1.55}',
      '.sipx-warnnote-t{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word}',
      '.sipx-warnnote-x{flex:0 0 auto;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:var(--fg2);cursor:pointer;font-size:12px;line-height:1}',
      '.sipx-card{border:1px solid var(--line);border-radius:12px;overflow:hidden}',
      '.sipx-card-h{display:flex;align-items:center;gap:7px;padding:9px 11px 8px}',
      '.sipx-card-t{font-size:12px;font-weight:600}',
      '.sipx-card-c{padding:0 11px 11px}',
      '.sipx-sep{height:1px;background:var(--line)}',
      '.sipx-row{display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-radius:9px}',
      '.sipx-row:hover{background:var(--l2)}',
      '.sipx-txt{flex:1;min-width:0;word-break:break-word}',
      '.sipx-meta{color:var(--fg2);font-size:11px;font-variant-numeric:tabular-nums}',
      '.sipx-sect{display:flex;align-items:center;gap:6px;margin:10px 0 2px;color:var(--fg2);font-size:10.5px;font-weight:600;letter-spacing:.06em}',
      '.sipx-sect i{flex:1;height:1px;background:var(--line);display:block}',
      '.sipx-empty{padding:10px 2px;color:var(--fg2);font-size:11.5px;line-height:1.6}',
      '.sipx-empty b{display:block;color:var(--fg);font-weight:600;margin-bottom:2px}',
      '.sipx-btn{height:24px;padding:0 10px;border-radius:8px;border:1px solid var(--line2);background:transparent;color:var(--fg);font-size:11.5px;cursor:pointer;white-space:nowrap}',
      '.sipx-btn:hover{background:var(--l2)}',
      '.sipx-btn.primary{border-color:' + BRAND + ';background:' + BRAND + ';color:#fff}',
      '.sipx-btn.danger{color:' + ERR + '}',
      '.sipx-btn.danger:hover{border-color:' + ERR + ';background:color-mix(in srgb,' + ERR + ' 8%,transparent)}',
      '.sipx-btn.ghost{width:22px;height:22px;padding:0;border-color:transparent;color:var(--fg2);opacity:0}',
      '.sipx-row:hover .sipx-btn.ghost{opacity:1}',
      '.sipx-btn.ghost:hover{color:' + ERR + ';background:color-mix(in srgb,' + ERR + ' 10%,transparent)}',
      '.sipx-btn[disabled]{opacity:.45;cursor:default}',
      '.sipx-seg{display:inline-flex;padding:2px;gap:2px;border-radius:10px;background:var(--l2);border:1px solid var(--line)}',
      '.sipx-seg button{height:24px;padding:0 9px;border:0;border-radius:8px;background:transparent;color:var(--fg2);font-size:11.5px;cursor:pointer;white-space:nowrap}',
      '.sipx-seg button.on{background:var(--l1);color:var(--fg);font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.09)}',
      '.sipx-tabs{display:flex;flex-wrap:wrap;gap:5px}',
      '.sipx-tab{display:inline-flex;align-items:center;gap:5px;height:23px;padding:0 9px;border-radius:999px;border:1px solid var(--line);background:transparent;color:var(--fg2);font-size:11px;cursor:pointer}',
      '.sipx-tab:hover{background:var(--l2)}',
      '.sipx-tab.on{border-color:color-mix(in srgb,' + BRAND + ' 50%,transparent);background:color-mix(in srgb,' + BRAND + ' 11%,transparent);color:' + BRAND + ';font-weight:600}',
      '.sipx-kv{display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:3px 0}',
      '.sipx-kv .k{color:var(--fg2)}',
      '.sipx-kv .v{font-variant-numeric:tabular-nums;font-weight:550}',
      '.sipx-input{width:100%;height:28px;margin-top:8px;padding:0 10px;border-radius:9px;border:1px solid var(--line);background:var(--l2);color:var(--fg);font-size:11.5px}',
      '.sipx-input:focus{outline:none;border-color:' + BRAND + ';background:var(--l1)}',
      '.sipx-note{color:var(--fg2);font-size:11px;margin-top:6px;word-break:break-all}',
      '.sipx-add{display:flex;gap:6px;align-items:center;margin-top:8px}',
      '.sipx-addbtn{flex:1;height:26px;border-radius:9px;border:1px dashed var(--line2);background:transparent;color:var(--fg2);font-size:11.5px;cursor:pointer}',
      '.sipx-addbtn:hover{border-color:' + BRAND + ';color:' + BRAND + '}',
      '.sipx-toast{margin:0 10px 8px;padding:7px 10px;border-radius:10px;font-size:11.5px;border:1px solid var(--line);background:var(--l2)}',
      '.sipx-toast.ok{border-color:color-mix(in srgb,' + OK + ' 45%,transparent);color:' + OK + '}',
      '.sipx-toast.bad{border-color:color-mix(in srgb,' + ERR + ' 45%,transparent);color:' + ERR + '}',
      '.sipx-elsewhere{margin-top:8px;padding:7px 9px;border-radius:9px;background:var(--l2);color:var(--fg2);font-size:11px;line-height:1.55}',
    ].join('\n')

    /** 分区元数据：面板要自己显示标题，不能依赖后端把中文标题传全 */
    /**
     * 分区元数据：label 是标签页/按钮上的凝练名，title 是「全部」视图里的分区小标题。
     * 不要把长标题截断当标签（曾截出"事实与偏""待验证假"这种半截词）。
     */
    const SECTIONS = [
      { key: 'FACTS', label: '事实', title: '事实与偏好', hint: '长期成立的事实与用户偏好' },
      { key: 'LESSONS', label: '教训', title: '经验教训', hint: '踩过的坑与对策' },
      { key: 'METHODS', label: '方法', title: '方法与技巧', hint: '可复用的做事方式' },
      { key: 'RESOURCES', label: '资料', title: '网站与资料', hint: '好用的网站、工具、文档' },
      { key: 'PRINCIPLES', label: '原则', title: '沉淀原则', hint: '睡眠期归纳出的高层原则' },
      { key: 'HYPOTHESES', label: '假设', title: '待验证假设', hint: '尚未证实的推测' },
    ]
    const TABS = [{ key: 'ALL', label: '全部' }].concat(SECTIONS.map((section) => ({ key: section.key, label: section.label })))
    const sectionOf = (key) => SECTIONS.filter((section) => section.key === key)[0] || SECTIONS[0]
    const titleOf = (key) => sectionOf(key).title
    const hintOf = (key) => sectionOf(key).hint

    const call = async (path, payload, sessionId) => {
      const query = sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : ''
      const options = payload
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
        : { method: 'GET' }
      const response = await fetch('/selfip' + path + query, options)
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return await response.json()
    }

    function Panel(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : ''
      const [layout, setLayout] = react.useState(() => {
        try {
          const saved = window.localStorage.getItem('selfip-panel-layout')
          return saved === 'float' || saved === 'folded' ? saved : 'drawer'
        } catch {
          return 'drawer'
        }
      })
      const [data, setData] = react.useState(null)
      const [toast, setToast] = react.useState(null)
      // 切换经验范围会"遮住"另一层记忆（数据不搬），提示要能看清且不被自动收掉
      const [scopeWarn, setScopeWarn] = react.useState('')
      const [busy, setBusy] = react.useState('')
      const [tab, setTab] = react.useState('ALL')
      const [note, setNote] = react.useState('')
      const [adding, setAdding] = react.useState(false)
      const [draft, setDraft] = react.useState('')

      const sessionRef = react.useRef(sessionId)
      sessionRef.current = sessionId
      const timerRef = react.useRef(null)

      const say = (text, kind) => {
        setToast({ text: text, kind: kind || 'ok' })
        if (timerRef.current) window.clearTimeout(timerRef.current)
        timerRef.current = window.setTimeout(() => setToast(null), kind === 'bad' ? 8000 : 3200)
      }

      const load = react.useCallback(() => {
        return call('/state', null, sessionRef.current)
          .then((result) => {
            if (result && result.ok) setData(result)
            else say((result && result.error) || '读取失败', 'bad')
          })
          .catch((err) => say(String((err && err.message) || err), 'bad'))
      }, [])

      react.useEffect(() => {
        load()
        const timer = window.setInterval(load, 5000)
        return () => {
          window.clearInterval(timer)
          if (timerRef.current) window.clearTimeout(timerRef.current)
        }
      }, [load, sessionId])

      const applyLayout = (next) => {
        setLayout(next)
        try {
          window.localStorage.setItem('selfip-panel-layout', next)
        } catch {
          /* 仅本次会话 */
        }
      }

      /** 写动作统一入口：成功/失败都给行内反馈，不再是静默变化。 */
      const act = (busyKey, path, payload, okText) => {
        setBusy(busyKey)
        return call(path, { ...payload, sessionId: sessionRef.current }, sessionRef.current)
          .then((result) => {
            setBusy('')
            if (result && result.ok) say(okText)
            else say((result && result.error) || '操作失败', 'bad')
            return load()
          })
          .catch((err) => {
            setBusy('')
            say(String((err && err.message) || err), 'bad')
          })
      }

      // 提案在哪取决于经验范围：workspace/both 在本工作区库，global 在共享库
      const globalMode = data && data.scope === 'global'
      const proposals = globalMode
        ? (data && data.global && data.global.proposals) || []
        : (data && data.proposals) || []
      const elsewhere = (data && data.proposalsElsewhere) || []
      // 记忆库要显示"实际生效的库"：global 模式下注入与检索都取自全局库，本工作区库完全不参与。
      // 优先用 host 明确下发的 data.effective（判定唯一来源）；仅在旧版 host 未下发时，
      // 才按 scope 自行推断——避免展示层与 host 各维护一套判定逻辑而分叉。
      const effective =
        (data && data.effective) || (globalMode ? data && data.global : data && data.workspace) || null
      const backendSections = (effective && effective.sections) || []
      // counts 必须由 sections 现算：pLibrary 返回的库对象只有 label/dir/sections/proposals，
      // 没有 counts 字段；顶层 data.counts 统计的是**本工作区库**，global 模式下不能用
      const counts = {}
      for (const section of backendSections) counts[section.key] = section.count || 0
      const total = backendSections.reduce((sum, section) => sum + (section.count || 0), 0)
      const memoryLabel = (data && data.effectiveLabel) || '记忆库'
      const folded = layout === 'folded'
      // 后端只返回有条目的分区；面板按自己的固定顺序补齐，保证「全部」视图顺序稳定
      const sections = SECTIONS.map((meta) => {
        const found = backendSections.filter((section) => section.key === meta.key)[0]
        return {
          key: meta.key,
          title: meta.title,
          hint: meta.hint,
          count: counts[meta.key] || 0,
          entries: (found && found.entries) || [],
          freeform: (found && found.freeform) || '',
        }
      })

      const head = react.createElement(
        'div',
        { className: 'sipx-head' },
        react.createElement('span', { className: 'sipx-mark' }, '改'),
        react.createElement(
          'div',
          {
            className: 'sipx-brandrow',
            style: { cursor: folded ? 'pointer' : 'default' },
            onClick: folded ? () => applyLayout('drawer') : undefined,
          },
          react.createElement('span', { className: 'sipx-title' }, '自我改进'),
          react.createElement('span', { className: 'sipx-eyebrow' }, 'SELF-IMPROVEMENT'),
        ),
        react.createElement('span', { className: 'sipx-spacer' }),
        react.createElement('span', { className: 'sipx-chip' }, proposals.length ? '⚠ 待批 ' + proposals.length : '无待批'),
        react.createElement('span', { className: 'sipx-count' }, '记忆 ' + total),
        react.createElement(
          'div',
          { style: { display: 'flex', gap: 2 } },
          folded
            ? null
            : react.createElement(
                'button',
                { className: 'sipx-icon', title: layout === 'drawer' ? '切换为浮层' : '切换为抽屉', onClick: () => applyLayout(layout === 'drawer' ? 'float' : 'drawer') },
                layout === 'drawer' ? '❐' : '⌷',
              ),
          folded ? null : react.createElement('button', { className: 'sipx-icon', title: '刷新', onClick: load }, '↻'),
          react.createElement(
            'button',
            { className: 'sipx-icon', title: folded ? '展开' : '收起', onClick: () => applyLayout(folded ? 'drawer' : 'folded') },
            folded ? '▸' : '✕',
          ),
        ),
      )

      if (folded) {
        return react.createElement('div', { className: 'sipx-fold' }, react.createElement('div', { className: 'sipx-shell' }, head))
      }

      const shellClass = 'sipx-shell ' + (layout === 'drawer' ? 'sipx-drawer' : 'sipx-float')
      const cards = []

      // 1) 待批提案：本工作区可操作；其他工作区的只提示
      cards.push(
        react.createElement(
          'div',
          { className: 'sipx-card', key: 'proposals' },
          react.createElement(
            'div',
            { className: 'sipx-card-h' },
            react.createElement('span', { className: proposals.length || elsewhere.length ? 'sipx-dot alert' : 'sipx-dot' }),
            react.createElement('span', { className: 'sipx-card-t' }, '待批提案'),
            react.createElement('span', { className: 'sipx-spacer' }),
            react.createElement('span', { className: 'sipx-count' }, String(proposals.length)),
          ),
          react.createElement('div', { className: 'sipx-sep' }),
          react.createElement(
            'div',
            { className: 'sipx-card-c' },
            proposals.length
              ? proposals.map((item) =>
                  react.createElement(
                    'div',
                    { key: item.id, style: { paddingTop: 9 } },
                    react.createElement('div', { style: { wordBreak: 'break-word' } }, item.summary),
                    react.createElement('div', { className: 'sipx-meta' }, item.id),
                    react.createElement(
                      'div',
                      { style: { display: 'flex', gap: 6, marginTop: 7 } },
                      react.createElement(
                        'button',
                        { className: 'sipx-btn primary', disabled: busy !== '', onClick: () => { act(item.id + 'a', '/proposal', { id: item.id, action: 'accept', note }, '已采纳该提案'); setNote('') } },
                        busy === item.id + 'a' ? '处理中…' : '采纳',
                      ),
                      react.createElement(
                        'button',
                        { className: 'sipx-btn danger', disabled: busy !== '', onClick: () => { act(item.id + 'r', '/proposal', { id: item.id, action: 'reject', note }, '已否决，理由已写入记忆'); setNote('') } },
                        busy === item.id + 'r' ? '处理中…' : '否决',
                      ),
                    ),
                  ),
                )
              : react.createElement(
                  'div',
                  { className: 'sipx-empty' },
                  react.createElement('b', null, '✓ 无待批提案'),
                  '复盘若发现插件自身缺陷，会在这里等你确认后才应用。',
                ),
            react.createElement('input', {
              className: 'sipx-input',
              placeholder: '否决理由（可选，会写入记忆）',
              value: note,
              onChange: (event) => setNote(event.target.value),
            }),
            elsewhere.length
              ? react.createElement(
                  'div',
                  { className: 'sipx-elsewhere' },
                  '其他工作区挂着 ' + elsewhere.length + ' 条待批提案（需切到该工作区处理）：',
                  elsewhere.map((item, index) => react.createElement('div', { key: index, style: { marginTop: 3 } }, '· ' + item.cwd + '：' + item.summary)),
                )
              : null,
          ),
        ),
      )

      // 2) 记忆库：全部视图按分区连续列出；单分区只列该区
      const shown = tab === 'ALL' ? sections.filter((section) => section.count) : sections.filter((section) => section.key === tab)
      const shownTotal = tab === 'ALL' ? total : counts[tab] || 0
      cards.push(
        react.createElement(
          'div',
          { className: 'sipx-card', key: 'memory' },
          react.createElement(
            'div',
            { className: 'sipx-card-h' },
            react.createElement('span', { className: 'sipx-card-t' }, memoryLabel),
            react.createElement('span', { className: 'sipx-spacer' }),
            react.createElement('span', { className: 'sipx-count' }, shownTotal + ' 条'),
          ),
          react.createElement('div', { className: 'sipx-sep' }),
          react.createElement(
            'div',
            { className: 'sipx-card-c', style: { paddingTop: 10 } },
            react.createElement(
              'div',
              { className: 'sipx-tabs' },
              TABS.map((item) =>
                react.createElement(
                  'button',
                  { key: item.key, className: tab === item.key ? 'sipx-tab on' : 'sipx-tab', onClick: () => setTab(item.key) },
                  item.label,
                  item.key === 'ALL' ? null : react.createElement('span', { className: 'sipx-count' }, String(counts[item.key] || 0)),
                ),
              ),
            ),
            shown.length
              ? shown.map((section) =>
                  react.createElement(
                    'div',
                    { key: section.key },
                    tab === 'ALL'
                      ? react.createElement(
                          'div',
                          { className: 'sipx-sect', title: section.hint },
                          section.title,
                          react.createElement('span', { className: 'sipx-count' }, String(section.count)),
                          react.createElement('i', null),
                        )
                      : null,
                    section.entries.map((entry, index) =>
                      react.createElement(
                        'div',
                        { className: 'sipx-row', key: section.key + index },
                        react.createElement(
                          'div',
                          { className: 'sipx-txt' },
                          entry.text,
                          entry.at ? react.createElement('div', { className: 'sipx-meta' }, String(entry.at).slice(0, 16).replace('T', ' ')) : null,
                        ),
                        react.createElement(
                          'button',
                          { className: 'sipx-btn ghost', disabled: busy !== '', title: '作废（保留历史）', onClick: () => act('mem' + section.key, '/memory', { action: 'invalidate', section: section.key, text: entry.text }, '已作废 1 条') },
                          '✕',
                        ),
                      ),
                    ),
                    section.freeform ? react.createElement('div', { className: 'sipx-note', style: { whiteSpace: 'pre-wrap' } }, section.freeform) : null,
                  ),
                )
              : react.createElement('div', { className: 'sipx-empty' }, tab === 'ALL' ? '还没有沉淀任何记忆。' : '该分区暂无条目。'),
            adding
              ? react.createElement(
                  'div',
                  null,
                  react.createElement('input', {
                    className: 'sipx-input',
                    autoFocus: true,
                    placeholder: '写一条要长期记住的内容 →「' + titleOf(tab === 'ALL' ? 'FACTS' : tab) + '」',
                    value: draft,
                    onChange: (event) => setDraft(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' && draft.trim()) {
                        act('add', '/memory', { action: 'add', section: tab === 'ALL' ? 'FACTS' : tab, text: draft }, '已记住 1 条')
                        setDraft('')
                        setAdding(false)
                      } else if (event.key === 'Escape') {
                        setDraft('')
                        setAdding(false)
                      }
                    },
                  }),
                  react.createElement(
                    'div',
                    { className: 'sipx-add' },
                    react.createElement('button', { className: 'sipx-btn primary', disabled: busy !== '' || !draft.trim(), onClick: () => { act('add', '/memory', { action: 'add', section: tab === 'ALL' ? 'FACTS' : tab, text: draft }, '已记住 1 条'); setDraft(''); setAdding(false) } }, '记住'),
                    react.createElement('button', { className: 'sipx-btn', onClick: () => { setDraft(''); setAdding(false) } }, '取消'),
                  ),
                )
              : react.createElement(
                  'div',
                  { className: 'sipx-add' },
                  react.createElement('button', { className: 'sipx-btn sipx-addbtn', onClick: () => setAdding(true) }, '+ 加一条到「' + titleOf(tab === 'ALL' ? 'FACTS' : tab) + '」'),
                ),
          ),
        ),
      )

      // 3) 经验范围
      cards.push(
        react.createElement(
          'div',
          { className: 'sipx-card', key: 'scope' },
          react.createElement(
            'div',
            { className: 'sipx-card-h' },
            react.createElement('span', { className: 'sipx-card-t' }, '经验范围'),
            react.createElement('span', { className: 'sipx-spacer' }),
            react.createElement(
              'span',
              { className: 'sipx-chip', title: 'both 为单向只读复用：只读取其他工作区经验，不外流本工作区经验，因此不提升' },
              // both 下提升被刻意禁用，显示开/关会误导；只有 global 模式才谈得上"提升"
              (data && data.scope) === 'both'
                ? '不外流（单向复用）'
                : data && data.autoPromote
                  ? '自动提升开'
                  : '自动提升关',
            ),
          ),
          react.createElement('div', { className: 'sipx-sep' }),
          react.createElement(
            'div',
            { className: 'sipx-card-c', style: { paddingTop: 10 } },
            react.createElement(
              'div',
              { className: 'sipx-seg' },
              [
                ['workspace', '工作区'],
                ['both', '工作区 + 全局只读'],
                ['global', '全部共用'],
              ].map((pair) =>
                react.createElement(
                  'button',
                  {
                    key: pair[0],
                    className: data && data.scope === pair[0] ? 'on' : '',
                    disabled: busy === 'scope',
                    onClick: () =>
                      call('/config', { scope: pair[0], globalDir: data ? data.globalDir : '', sessionId: sessionRef.current }, sessionRef.current)
                        .then((result) => {
                          if (result && result.ok) {
                            say('已切换为「' + pair[1] + '」' + (result.migrated ? '，并迁移了 ' + result.migrated + ' 条待批提案到共享库' : ''))
                            // 服务端把"这次切换会遮住哪一层、多少条"算好了，常驻显示到用户手动关掉
                            setScopeWarn(result.scopeNote ? String(result.scopeNote) : '')
                          } else {
                            say((result && result.error) || '切换失败', 'bad')
                          }
                          return load()
                        })
                        .catch((err) => say(String((err && err.message) || err), 'bad')),
                  },
                  pair[1],
                ),
              ),
            ),
            react.createElement('div', { className: 'sipx-note' }, '全局库 ' + ((data && data.globalDir) || '未配置')),
            data && data.cwd ? react.createElement('div', { className: 'sipx-note' }, '工作区 ' + data.cwd) : null,
          ),
        ),
      )

      // 4) 运行状态
      const cost = data && data.cost
      const byKind = (cost && cost.byKind) || {}
      cards.push(
        react.createElement(
          'div',
          { className: 'sipx-card', key: 'status' },
          react.createElement(
            'div',
            { className: 'sipx-card-h' },
            react.createElement('span', { className: 'sipx-card-t' }, '运行状态'),
            react.createElement('span', { className: 'sipx-spacer' }),
            react.createElement('span', { className: 'sipx-count' }, data && data.pending ? '队列 ' + data.pending : '队列空'),
          ),
          react.createElement('div', { className: 'sipx-sep' }),
          react.createElement(
            'div',
            { className: 'sipx-card-c', style: { paddingTop: 8 } },
            react.createElement('div', { className: 'sipx-kv' }, react.createElement('span', { className: 'k' }, '待复盘队列'), react.createElement('span', { className: 'v' }, String((data && data.pending) || 0) + ' 条')),
            react.createElement('div', { className: 'sipx-kv' }, react.createElement('span', { className: 'k' }, '今日 token'), react.createElement('span', { className: 'v' }, String((cost && cost.spent) || 0))),
            react.createElement('div', { className: 'sipx-kv' }, react.createElement('span', { className: 'k' }, '复盘 / 睡眠'), react.createElement('span', { className: 'v' }, String(((byKind['session-retro'] || {}).calls) || 0) + ' / ' + String(((byKind.sleep || {}).calls) || 0))),
            react.createElement('div', { className: 'sipx-kv' }, react.createElement('span', { className: 'k' }, '上次巩固'), react.createElement('span', { className: 'v' }, data && data.sleptAt ? String(data.sleptAt).slice(5, 16).replace('T', ' ') : '—')),
            react.createElement('div', { className: 'sipx-kv' }, react.createElement('span', { className: 'k' }, '全局库条目'), react.createElement('span', { className: 'v' }, String((data && data.globalEntries) || 0) + ' 条')),
            data && data.handoff ? react.createElement('div', { className: 'sipx-note' }, data.handoff) : null,
          ),
        ),
      )

      return react.createElement(
        'div',
        { className: 'sipx-fold' },
        react.createElement(
          'div',
          { className: shellClass },
          head,
          toast ? react.createElement('div', { className: 'sipx-toast ' + (toast.kind === 'bad' ? 'bad' : 'ok') }, toast.text) : null,
          scopeWarn
            ? react.createElement(
                'div',
                { className: 'sipx-warnnote' },
                react.createElement('span', { className: 'sipx-warnnote-t' }, scopeWarn),
                react.createElement(
                  'button',
                  { className: 'sipx-warnnote-x', title: '知道了', onClick: () => setScopeWarn('') },
                  '✕',
                ),
              )
            : null,
          react.createElement('div', { className: 'sipx-body' }, react.createElement('div', { className: 'sipx-stack' }, cards)),
        ),
      )
    }

    /**
     * 浏览器半边：抽屉挂在输入框上方那一排（conversation.input.dock）。
     * 抽屉本体是 fixed 定位，注册项自身不占布局高度。
     */
    const inject = ['slots']

    function apply(ctx) {
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-self-improvement'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => {
          if (tag.parentNode) tag.parentNode.removeChild(tag)
        }
      }, 'self-improvement: panel styles')

      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register({ name: 'conversation.input.dock', id: 'self-improvement-panel', order: 5, label: '自我改进' }, (slotProps) =>
          react.createElement(Panel, { sessionId: slotProps && slotProps.sessionId ? slotProps.sessionId : '' }),
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-self-improvement-panel'
    return module.exports
  },
})
