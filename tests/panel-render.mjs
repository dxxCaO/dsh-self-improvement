/**
 * 面板前端渲染测试：用最小 React 桩真实渲染 Panel，断言「记忆库」卡片显示的是
 * **实际生效的库**（global 模式下 = 全局库），而不是永远显示本工作区库。
 *
 * 为什么要渲染而不是只查 API：上一轮修 share 显示问题时，host 端字段名对了、
 * API 返回也完整，但前端读了一个**不存在的字段**（effective.counts），
 * 结果卡片显示 0 条、文案变成"还没有沉淀任何记忆"。只查 API 完全测不出来。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url))

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  [' + detail + ']' : ''))
}

// ---------- 最小 React 桩：createElement 产出可检查的 JSON 树 ----------
function makeTree(type, props, ...children) {
  const flat = []
  for (const child of children) {
    if (Array.isArray(child)) flat.push(...child.flat(Infinity))
    else if (child !== null && child !== undefined && child !== false) flat.push(child)
  }
  return { type, props: props || {}, children: flat }
}
const hookState = { index: 0, values: [] }
const reactStub = {
  createElement: (type, props, ...children) =>
    typeof type === 'function'
      ? (() => {
          // 函数组件：重置 hook 游标后调用，保证每次渲染 hook 顺序一致
          hookState.index = 0
          return type({ ...(props || {}), children })
        })()
      : makeTree(type, props, ...children),
  useState: (initial) => {
    const i = hookState.index++
    if (!(i in hookState.values)) hookState.values[i] = typeof initial === 'function' ? initial() : initial
    return [hookState.values[i], () => {}]
  },
  useRef: () => ({ current: null }),
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}

/** 把渲染树拍平成文本，便于断言"卡片上显示了什么" */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (node.children) return textOf(node.children)
  return ''
}

/** 加载客户端模块，返回注册到 slot 的 Panel 渲染函数 */
function loadPanel() {
  const src = readFileSync(clientPath, 'utf8')
  let captured = null

  const moduleLoader = {
    load: (spec) => {
      // 客户端文件以 window.__ModuleLoader__.load({ id, factory }) 结尾，
      // factory 接收一个 require：这里只需支持 'react'
      const requireFn = (name) => {
        if (name === 'react') return reactStub
        return {}
      }
      const exportsObj = spec.factory(requireFn)
      const applyFn = exportsObj && exportsObj.apply
      if (typeof applyFn !== 'function') {
        throw new Error('client.js 未导出 apply')
      }
      const ctx = {
        effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
        slots: {
          inject: (_name, fn) => fn(),
          register: (_meta, render) => { captured = render },
        },
      }
      applyFn(ctx)
    },
  }

  const fakeWindow = {
    __ModuleLoader__: moduleLoader,
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  }
  const fakeDocument = {
    createElement: () => ({ dataset: {}, appendChild: () => {}, parentNode: null }),
    head: { appendChild: () => {} },
  }
  const fakeFetch = () => Promise.resolve({ json: () => Promise.resolve({}) })

  // 客户端文件是普通脚本（不是 ESM），用 Function 包一层注入浏览器全局
  new Function('window', 'document', 'fetch', src)(fakeWindow, fakeDocument, fakeFetch)
  return captured
}

/**
 * 渲染 Panel。Panel 的 useState 顺序固定：
 *   0 layout / 1 data / 2 toast / 3 scopeWarn / 4 busy / 5 tab / 6 note / 7 adding / 8 draft
 * 这里把 data 预置进 hook 槽（真实环境由 load() 的 setData 填充），单次渲染即可断言。
 */
const render = (panelRender, data) => {
  hookState.index = 0
  hookState.values = []
  hookState.values[0] = 'drawer' // layout
  hookState.values[1] = data // data
  hookState.values[5] = 'ALL' // tab
  return textOf(panelRender({ sessionId: 's1' }))
}

/** 构造 host 侧 /selfip/state 的返回（用真实字段名） */
const makeState = ({ scope, workspaceSections, globalSections }) => {
  const counts = {}
  for (const s of workspaceSections) counts[s.key] = s.count
  return {
    ok: true,
    cwd: 'C:\\ws',
    globalDir: 'C:\\Users\\user\\.dsh\\self-improvement',
    scope,
    scopeLabel: scope === 'global' ? '全局库共用' : '仅本工作区',
    autoPromote: true,
    workspace: { label: '本工作区', dir: 'C:\\ws', sections: workspaceSections, proposals: [] },
    global: scope !== 'workspace' ? { label: '全局库', dir: 'C:\\Users\\user\\.dsh\\self-improvement', sections: globalSections, proposals: [] } : null,
    counts,
    totalEntries: workspaceSections.reduce((n, s) => n + s.count, 0),
    globalEntries: globalSections.reduce((n, s) => n + s.count, 0),
    pending: 0,
    sleptAt: null,
    cost: null,
    handoff: '',
    proposals: [],
    proposalsElsewhere: [],
    effectiveIsGlobal: scope === 'global',
    effectiveLabel: scope === 'global' ? '记忆库（全局库 · 全部共用）' : '记忆库（本工作区）',
    diag: {},
  }
}

const sec = (key, count, firstText) => ({
  key,
  title: key,
  count,
  entries: Array.from({ length: count }, (_, i) => ({ at: '2026-09-12T03:00:00.000Z', kind: 'lesson', text: (i === 0 && firstText) || key + '-' + i })),
  freeform: '',
})

const panelRender = loadPanel()
check('客户端已加载并注册了 slot 渲染函数', typeof panelRender === 'function', typeof panelRender)

console.log('\n[1] global 模式：记忆库显示全局库，不再显示"还没有沉淀任何记忆"')
{
  const data = makeState({
    scope: 'global',
    workspaceSections: [], // 新工作区：本来就没有记忆
    globalSections: [sec('LESSONS', 16, '其他工作区沉淀的教训'), sec('FACTS', 10), sec('METHODS', 9)],
  })
  const out = render(panelRender, data)
  check('出现全局库标记', out.includes('全局库'), '')
  check('卡片标题标明全局库', out.includes('记忆库（全局库'), '')
  check('显示了其他工作区的条目文本', out.includes('其他工作区沉淀的教训'))
  check('分区计数不再是 0（教训 16）', /教训\s*16/.test(out), (out.match(/教训\s*\d+/g) || []).join(',') || '未找到')
  check('没有误报"还没有沉淀任何记忆"', !out.includes('还没有沉淀任何记忆'))
  check('顶部总数显示 35', out.includes('35 条'), (out.match(/\d+ 条/g) || []).join(',') || '-')
}

console.log('\n[2] workspace 模式：仍显示本工作区库（反向断言）')
{
  const data = makeState({
    scope: 'workspace',
    workspaceSections: [sec('LESSONS', 3, '本工作区的教训甲')],
    globalSections: [sec('LESSONS', 16, '其他工作区沉淀的教训')],
  })
  const out = render(panelRender, data)
  check('标题标明本工作区', out.includes('记忆库（本工作区）'), '')
  check('显示本工作区条目', out.includes('本工作区的教训甲'))
  check('不显示其他工作区的条目', !out.includes('其他工作区沉淀的教训'))
  check('计数为本工作区的 3', /教训\s*3/.test(out), (out.match(/教训\s*\d+/g) || []).join(',') || '-')
}

console.log('\n[3] global 模式且全局库为空：如实显示为空')
{
  const data = makeState({ scope: 'global', workspaceSections: [], globalSections: [] })
  const out = render(panelRender, data)
  check('空库时给出空状态文案', out.includes('还没有沉淀任何记忆'))
}

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败'))
process.exit(failures === 0 ? 0 : 1)
