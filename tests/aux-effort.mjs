/**
 * 后台归纳调用的模型参数测试（单进程单实例，避免与其他套件共享模块级 ctx）。
 *
 * 背景：插件的复盘/睡眠/压缩是"抽取与改写"型后台任务，却直接照抄会话当前的
 * reasoningEffort。会话把努力等级调高时，而带推理的模型把 reasoning token 计入
 * 输出预算，于是 retroMaxTokens=3000 被思考过程吃光 → finish 变成 max-tokens →
 * applyRetroOutput 只能按保守规则丢掉整段结论。真实运行里表现为
 * retroTruncated/retroAborted 持续增长，既白烧 token 又让复盘质量下降。
 *
 * 这里锁定修复后的行为：按适配器声明的努力等级挑最省的一档（优先 off），
 * 拿不到元数据时才回退到会话选择。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const sourcePath = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const source = await readFile(sourcePath, 'utf8')
const patched = source.replace(
  "import { defineTool } from '@deepseek-ai/dsh-tools'",
  'const defineTool = (options) => options',
)
const plugin = await import('data:text/javascript;base64,' + Buffer.from(patched, 'utf8').toString('base64'))

const root = mkdtempSync(join(tmpdir(), 'selfip-effort-'))
let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  [' + detail + ']' : ''))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 跑一次会触发后台模型调用的场景，返回捕获到的 stream options。
 * @param efforts 适配器声明的努力等级；null 表示不暴露 reasoning 元数据
 */
async function captureCall(efforts, { selectionEffort = 'max' } = {}) {
  const dir = join(root, 'ws-' + Math.random().toString(36).slice(2, 10))
  await mkdir(join(dir, 'self-improvement', 'logs'), { recursive: true })
  await mkdir(join(dir, 'self-improvement', 'memory'), { recursive: true })

  let captured = null
  const listeners = new Map()
  const tools = new Map()
  const roots = []

  const fsStub = {
    async resolve(path, opts) {
      const base = opts && opts.cwd ? opts.cwd : process.cwd()
      return { targetKey: /^([A-Za-z]:|[\\/])/.test(path) ? path : join(base, path), displayPath: path }
    },
    async readText(target) {
      return await readFile(target.targetKey, 'utf8')
    },
    async writeText(target, content) {
      await mkdir(join(target.targetKey, '..'), { recursive: true })
      const { writeFile } = await import('node:fs/promises')
      await writeFile(target.targetKey, String(content), 'utf8')
      return { operation: 'update', version: 'v', before: null, after: String(content) }
    },
    async listDir() {
      return []
    },
  }

  const ctx = {
    fs: fsStub,
    llm: {
      resolveModelInfo: async () => (efforts === null ? {} : { reasoning: { efforts } }),
      stream(options) {
        captured = options
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: '## LESSONS\n- 一条后台归纳产出的教训\n' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    systemPrompt: { section: () => () => {} },
    // 只提供 timeout：本测试不关心面板路径
    timer: { timeout: (cb, ms) => { const h = setTimeout(cb, Math.min(ms, 30)); return () => clearTimeout(h) } },
    sandboxPolicy: {
      workspaceRoot: '/',
      resolve: () => ({ mode: 'danger-full-access', workspaceRoot: dir, sessionId: 'effort-sid' }),
    },
    tools: { register: (d) => { tools.set(d.name, d); return () => {} } },
    on: (event, listener) => {
      const list = listeners.get(event) || []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    get(name) {
      if (name === 'agents') return { roots: () => roots }
      // 真实插件用 ctx.get('llm') 取服务（不是直接读 ctx.llm），桩必须照做
      if (name === 'llm') return ctx.llm
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'p', model: 'm', reasoningEffort: selectionEffort }) }
      }
      return undefined
    },
  }

  // agent 必须在 apply 前进入 roots：record.primary 由 apply 期的根采纳决定
  const agent = { id: 'effort-1', session: { id: 'effort-1', header: { cwd: dir } } }
  roots.push(agent)
  plugin.apply(ctx)
  await sleep(40)

  for (const listener of listeners.get('agent/error') || []) {
    listener({ agent, turn: 1, step: 1, error: new Error('effort-probe') })
  }
  for (let i = 0; i < 60 && captured === null; i++) await sleep(25)
  return captured
}

console.log('\n[1] 后台归纳调用按适配器声明挑最省的努力等级')
{
  const withOff = await captureCall([
    { id: 'off' },
    { id: 'low' },
    { id: 'high' },
    { id: 'max' },
  ])
  check('声明里有 off → 后台调用用 off', !!withOff && withOff.reasoningEffort === 'off', withOff ? String(withOff.reasoningEffort) : 'no call')
  check('调用确实带上了输出上限（截断留痕的前提）', !!withOff && typeof withOff.maxTokens === 'number' && withOff.maxTokens > 0, withOff ? String(withOff.maxTokens) : '-')
  check('后台调用带取消信号', !!withOff && !!withOff.signal, withOff && withOff.signal ? 'signal present' : 'missing')
}

console.log('\n[2] 没有 off 时退到适配器给出的最低一档（列表末位）')
{
  const noOff = await captureCall([{ id: 'high' }, { id: 'low' }])
  check('无 off → 取列表末位 low', !!noOff && noOff.reasoningEffort === 'low', noOff ? String(noOff.reasoningEffort) : 'no call')
}

console.log('\n[3] 拿不到元数据时行为不变（回退到会话选择）')
{
  const noMeta = await captureCall(null)
  check('无 reasoning 元数据 → 保持会话选择 max', !!noMeta && noMeta.reasoningEffort === 'max', noMeta ? String(noMeta.reasoningEffort) : 'no call')

  const emptyEfforts = await captureCall([])
  check('元数据为空列表 → 同样回退到会话选择', !!emptyEfforts && emptyEfforts.reasoningEffort === 'max', emptyEfforts ? String(emptyEfforts.reasoningEffort) : 'no call')
}

console.log('\n[4] 元数据查询失败不影响调用本身')
{
  const dir = join(root, 'ws-throw')
  await mkdir(join(dir, 'self-improvement', 'logs'), { recursive: true })
  await mkdir(join(dir, 'self-improvement', 'memory'), { recursive: true })
  let captured = null
  const listeners = new Map()
  const roots = []
  const ctx = {
    fs: {
      async resolve(p, o) {
        const base = o && o.cwd ? o.cwd : process.cwd()
        return { targetKey: /^([A-Za-z]:|[\\/])/.test(p) ? p : join(base, p), displayPath: p }
      },
      async readText() {
        return ''
      },
      async writeText() {
        return { operation: 'update', version: 'v', before: null, after: '' }
      },
      async listDir() {
        return []
      },
    },
    llm: {
      resolveModelInfo: async () => {
        throw new Error('metadata backend down')
      },
      stream(options) {
        captured = options
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: '## LESSONS\n- 仍然产出教训\n' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    systemPrompt: { section: () => () => {} },
    timer: { timeout: (cb, ms) => { const h = setTimeout(cb, Math.min(ms, 30)); return () => clearTimeout(h) } },
    sandboxPolicy: { workspaceRoot: '/', resolve: () => ({ mode: 'danger-full-access', workspaceRoot: dir, sessionId: 's' }) },
    tools: { register: () => () => {} },
    on: (e, f) => { const l = listeners.get(e) || []; l.push(f); listeners.set(e, l); return () => {} },
    get(name) {
      if (name === 'agents') return { roots: () => roots }
      if (name === 'llm') return ctx.llm
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm', reasoningEffort: 'max' }) }
      return undefined
    },
  }
  const agent = { id: 'throw-1', session: { id: 'throw-1', header: { cwd: dir } } }
  roots.push(agent)
  plugin.apply(ctx)
  await sleep(40)
  for (const l of listeners.get('agent/error') || []) l({ agent, turn: 1, step: 1, error: new Error('x') })
  for (let i = 0; i < 60 && captured === null; i++) await sleep(25)
  check('元数据查询抛错时仍按会话选择继续调用', !!captured && captured.reasoningEffort === 'max', captured ? String(captured.reasoningEffort) : 'no call')
}

console.log('\n[5] 模型路由：会话不提供模型时回退，而不是让后台链路静默停摆')
{
  const dir = join(root, 'ws-fallback')
  await mkdir(join(dir, 'self-improvement', 'logs'), { recursive: true })
  await mkdir(join(dir, 'self-improvement', 'memory'), { recursive: true })
  let captured = null
  const listeners = new Map()
  const roots = []
  const ctx = {
    fs: {
      async resolve(p, o) {
        const base = o && o.cwd ? o.cwd : process.cwd()
        return { targetKey: /^([A-Za-z]:|[\\/])/.test(p) ? p : join(base, p), displayPath: p }
      },
      async readText() {
        return ''
      },
      async writeText() {
        return { operation: 'update', version: 'v', before: null, after: '' }
      },
      async listDir() {
        return []
      },
    },
    llm: {
      listProviders: async () => [{ id: 'fallback-provider', defaultModel: 'fallback-model' }],
      resolveModelInfo: async () => ({ defaultMaxTokens: 8000 }),
      stream(options) {
        captured = options
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: '## LESSONS\n- 兜底路由也能跑\n' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    systemPrompt: { section: () => () => {} },
    timer: { timeout: (cb, ms) => { const h = setTimeout(cb, Math.min(ms, 30)); return () => clearTimeout(h) } },
    sandboxPolicy: { workspaceRoot: '/', resolve: () => ({ mode: 'danger-full-access', workspaceRoot: dir, sessionId: 'fb' }) },
    tools: { register: () => () => {} },
    on: (e, f) => { const l = listeners.get(e) || []; l.push(f); listeners.set(e, l); return () => {} },
    get(name) {
      if (name === 'agents') return { roots: () => roots }
      if (name === 'llm') return ctx.llm
      // 会话完全没提供模型选择（旧实现会在这里 return null，后台链路全部停摆）
      if (name === 'agentDefaultModel') return { currentSelection: () => undefined }
      return undefined
    },
  }
  const agent = { id: 'fb-1', session: { id: 'fb-1', header: { cwd: dir } } }
  roots.push(agent)
  plugin.apply(ctx)
  await sleep(40)
  for (const l of listeners.get('agent/error') || []) l({ agent, turn: 1, step: 1, error: new Error('fb') })
  for (let i = 0; i < 60 && captured === null; i++) await sleep(25)
  check('会话未提供模型时仍发起了调用（不再静默停摆）', !!captured, captured ? 'called' : 'no call')
  check('回退到 llm 声明的 provider', !!captured && captured.provider === 'fallback-provider', captured ? String(captured.provider) : '-')
  check('回退到 llm 声明的 model', !!captured && captured.model === 'fallback-model', captured ? String(captured.model) : '-')
}

console.log('\n[6] 输出预算：元数据可用时按适配器上限（留余量），显式值仍优先')
{
  const dir = join(root, 'ws-budget')
  await mkdir(join(dir, 'self-improvement', 'logs'), { recursive: true })
  await mkdir(join(dir, 'self-improvement', 'memory'), { recursive: true })
  let captured = null
  const listeners = new Map()
  const roots = []
  const ctx = {
    fs: {
      async resolve(p, o) {
        const base = o && o.cwd ? o.cwd : process.cwd()
        return { targetKey: /^([A-Za-z]:|[\\/])/.test(p) ? p : join(base, p), displayPath: p }
      },
      async readText() {
        return ''
      },
      async writeText() {
        return { operation: 'update', version: 'v', before: null, after: '' }
      },
      async listDir() {
        return []
      },
    },
    llm: {
      resolveModelInfo: async () => ({ defaultMaxTokens: 12000 }),
      stream(options) {
        captured = options
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: '## LESSONS\n- 预算来自元数据\n' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    systemPrompt: { section: () => () => {} },
    timer: { timeout: (cb, ms) => { const h = setTimeout(cb, Math.min(ms, 30)); return () => clearTimeout(h) } },
    sandboxPolicy: { workspaceRoot: '/', resolve: () => ({ mode: 'danger-full-access', workspaceRoot: dir, sessionId: 'bg' }) },
    tools: { register: () => () => {} },
    on: (e, f) => { const l = listeners.get(e) || []; l.push(f); listeners.set(e, l); return () => {} },
    get(name) {
      if (name === 'agents') return { roots: () => roots }
      if (name === 'llm') return ctx.llm
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return undefined
    },
  }
  const agent = { id: 'bg-1', session: { id: 'bg-1', header: { cwd: dir } } }
  roots.push(agent)
  plugin.apply(ctx)
  await sleep(40)
  for (const l of listeners.get('agent/error') || []) l({ agent, turn: 1, step: 1, error: new Error('bg') })
  for (let i = 0; i < 60 && captured === null; i++) await sleep(25)
  // error-retro 显式传 LIMITS.retroMaxTokens(3000)：显式值必须优先，不能被元数据覆盖
  check('显式传入的 maxTokens 优先（error-retro 仍为 3000）', !!captured && captured.maxTokens === 3000, captured ? String(captured.maxTokens) : '-')
}

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败'))
rmSync(root, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
