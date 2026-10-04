/**
 * 契约与故障注入测试：这一层专门覆盖"桩测试永远抓不到"的东西。
 *
 * 与 smoke.mjs 的区别：
 *  - 使用**真实** defineTool（从 profile 解析），因此 schema 编译与参数校验真的会跑；
 *  - messageFeedback 返回**真实包装**形状 { ok, value: { items } }；
 *  - 模型流是**异步** generator（真实形态），并检查 signal 已接线；
 *  - 故障注入：写围栏拒绝、模型抛错、队列重试、强杀恢复。
 *
 * 运行：node tests/contract.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

// ---------- 真实依赖：优先从 DSH profile 解析，解析不到就退化为裸模块解析 ----------
// 不写死任何机器的绝对路径：CI、本地仓库、以及从 profile 里跑测试都能工作。
const PROFILE = (() => {
  const candidates = []
  if (process.env.DSH_PROFILE) candidates.push(join(process.env.DSH_PROFILE, 'package.json'))
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i += 1) {
    const parent = dirname(dir)
    if (parent === dir) break
    candidates.push(join(parent, '.dsh', 'profiles', 'web', 'package.json'))
    dir = parent
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
})()
const requireFromProfile = PROFILE ? createRequire(PROFILE) : createRequire(import.meta.url)
let toolsEntry
try {
  toolsEntry = requireFromProfile.resolve('@deepseek-ai/dsh-tools')
} catch {
  toolsEntry = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-tools'))
}
const { defineTool } = await import(pathToFileURL(toolsEntry).href)

const sourcePath = new URL('../lib/index.js', import.meta.url)
const source = await readFile(sourcePath, 'utf8')
const patched = source.replace(
  "import { defineTool } from '@deepseek-ai/dsh-tools'",
  `import { defineTool } from '${pathToFileURL(toolsEntry).href}'`,
)
if (patched === source) {
  console.error('未能替换 defineTool 导入，前置条件变化')
  process.exit(1)
}
const plugin = await import('data:text/javascript;base64,' + Buffer.from(patched, 'utf8').toString('base64'))

if (typeof defineTool !== 'function') {
  console.error('真实 defineTool 解析失败')
  process.exit(1)
}

const workdir = mkdtempSync(join(tmpdir(), 'selfip-contract-'))
let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  [' + detail + ']' : ''))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轮询等待异步链完成，避免固定 sleep 在机器繁忙时产生假失败 */
const waitFor = async (predicate, { timeoutMs = 4000, intervalMs = 40 } = {}) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let ok = false
    try {
      ok = await predicate()
    } catch {
      ok = false
    }
    if (ok) return true
    if (Date.now() > deadline) return false
    await sleep(intervalMs)
  }
}

/** 原子写 + 重试：Windows 上 rename 撞到并发读句柄会 EPERM，真实后端同样带重试 */
const writeAtomic = async (targetPath, text) => {
  const tmp = targetPath + '.tmp-' + Math.random().toString(36).slice(2, 8)
  await writeFile(tmp, text, 'utf8')
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, targetPath)
      return
    } catch (error) {
      const retryable = error && (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EEXIST')
      if (!retryable || attempt >= 8) throw error
      await sleep(5 + attempt * 5)
    }
  }
}

// ---------- 桩（仅"壳"：服务对象替换，契约形状保持真实） ----------
function makeCtx({ dir, mode = 'danger-full-access', feedback, stream, denyWrite = false }) {
  const listeners = new Map()
  const tools = new Map()
  const sections = []
  const roots = []
  const writes = []
  const streamCalls = []

  const fsStub = {
    async resolve(path, opts) {
      const base = opts && opts.cwd ? opts.cwd : process.cwd()
      return { targetKey: /^([A-Za-z]:|[\\/])/.test(path) ? path : join(base, path), displayPath: path }
    },
    async readText(target) {
      return await readFile(target.targetKey, 'utf8')
    },
    async writeText(target, content, expected, signal, policy) {
      writes.push({ path: target.targetKey, policy })
      if (denyWrite) {
        const error = new Error('file access denied under ' + (policy ? policy.mode : 'unknown') + ' mode')
        error.code = 'FS_DENIED'
        throw error
      }
      await mkdir(dirname(target.targetKey), { recursive: true })
      // 契约要求 mutation 原子化（真实后端为 tmp+rename）：原地覆盖会让并发读读到半截内容
      await writeAtomic(target.targetKey, String(content))
      return { operation: 'update', version: 'v', before: null, after: String(content) }
    },
    async listDir(target) {
      const entries = await readdir(target.targetKey, { withFileTypes: true })
      return entries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
        target: { targetKey: join(target.targetKey, e.name), displayPath: e.name },
      }))
    },
  }

  const ctx = {
    fs: fsStub,
    llm: {
      stream(options) {
        streamCalls.push(options)
        return stream ? stream(options) : (async function* () {})()
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    timer: { timeout: (cb, ms) => { const h = setTimeout(cb, Math.min(ms, 40)); return () => clearTimeout(h) } },
    sandboxPolicy: {
      workspaceRoot: '/',
      resolve: () => ({ mode, workspaceRoot: dir, sessionId: 'contract-sid' }),
    },
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
    on: (event, listener) => {
      const list = listeners.get(event) || []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    get: (name) => {
      if (name === 'agents') return { roots: () => roots }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }) }
      if (name === 'messageFeedback') return { list: async () => feedback }
      return undefined
    },
  }

  return {
    ctx,
    tools,
    sections,
    roots,
    writes,
    streamCalls,
    fsStub,
    emit: (event, ...args) => {
      for (const listener of listeners.get(event) || []) listener(...args)
    },
    agent: (id) => ({ id, session: { header: { cwd: dir } } }),
  }
}

const readAt = async (dir, rel) => {
  try {
    return await readFile(join(dir, 'self-improvement', rel), 'utf8')
  } catch {
    return null
  }
}

// ================= 1. 真实 defineTool 下的工具契约 =================
console.log('\n[1] 真实 defineTool 下的工具契约')
{
  const dir = join(workdir, 'ws-contract')
  await mkdir(dir, { recursive: true })
  const h = makeCtx({ dir })
  plugin.apply(h.ctx)
  const agent = h.agent('c1')
  h.roots.push(agent)
  h.emit('agent/session-start', { agent, source: 'startup' })
  await sleep(60)

  check('apply 在真实 defineTool 下不抛错', h.tools.size === 6, [...h.tools.keys()].join(','))
  const remember = h.tools.get('remember')
  check('工具定义具备可执行体', !!remember && typeof remember.execute === 'function')

  // 哨兵：恒等桩下这三条永远不会抛，因此它们同时证明"跑的是真实契约"
  let threwMissing = false
  try {
    await remember.execute({}, { agent })
  } catch (error) {
    threwMissing = /invalid arguments|missing required/i.test(error.message)
  }
  check('缺少必填参数被真实校验拦截', threwMissing)

  let threwType = false
  try {
    await remember.execute({ note: 'x', importance: 'high' }, { agent })
  } catch (error) {
    threwType = /invalid arguments|integer/i.test(error.message)
  }
  check('参数类型错误被真实校验拦截', threwType)

  let threwEnum = false
  try {
    await remember.execute({ note: 'x', kind: 'nope' }, { agent })
  } catch (error) {
    threwEnum = /invalid arguments|one of/i.test(error.message)
  }
  check('枚举值错误被真实校验拦截', threwEnum)

  const ok = await remember.execute({ note: '契约测试写入的条目', importance: 6 }, { agent })
  check('合法调用返回符合 output.schema 的值', ok && typeof ok.ok === 'boolean' && typeof ok.file === 'string', JSON.stringify(ok))
  check('写入确实落盘', ((await readAt(dir, 'memory/facts.md')) || '').includes('契约测试写入的条目'))
}

// ================= 2. 沙箱围栏确实生效 =================
console.log('\n[2] 沙箱围栏分支（桩测试永远走不到）')
{
  const dir = join(workdir, 'ws-fence')
  await mkdir(dir, { recursive: true })
  const h = makeCtx({ dir, mode: 'workspace-write', denyWrite: true })
  plugin.apply(h.ctx)
  const agent = h.agent('c2')
  h.roots.push(agent)
  h.emit('agent/session-start', { agent, source: 'startup' })
  await sleep(60)
  const result = await h.tools.get('remember').execute({ note: '被围栏拒绝的写入' }, { agent })
  check('写入被拒时工具返回失败（不谎报成功）', result.ok === false, JSON.stringify(result))
  check('失败原因被记录（可诊断）', /denied|FS_DENIED/i.test(String(result.detail)))
  const policySeen = h.writes.map((w) => w.policy && w.policy.mode).filter(Boolean)
  check('策略确实作为第 5 参传入写操作', policySeen.includes('workspace-write'), policySeen.join(',') || 'none')
}

// ================= 3. 真实 messageFeedback 包装 + 异步流 =================
console.log('\n[3] 真实反馈包装与异步模型流')
{
  const dir = join(workdir, 'ws-feedback')
  await mkdir(dir, { recursive: true })
  const h = makeCtx({
    dir,
    feedback: { ok: true, value: { items: [{ messageId: 'm-9', rating: 'negative', note: '不是我要的', version: 'v1', createdAt: 0, updatedAt: 0 }] } },
    stream: async function* () {
      await sleep(5)
      yield { type: 'text-delta', index: 0, text: '## LESSONS\n' }
      await sleep(5)
      yield { type: 'text-delta', index: 0, text: '- 异步流累积正确' }
      yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 30 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  plugin.apply(h.ctx)
  const agent = h.agent('c3')
  h.roots.push(agent)
  h.emit('agent/session-start', { agent, source: 'startup' })
  h.emit('session/event', { id: 'c3' }, { type: 'user/message', seq: 1, time: Date.now(), data: { id: 'u1', content: [{ type: 'text', text: '改一下这段' }] } })
  h.emit('session/event', { id: 'c3' }, { type: 'assistant/message', seq: 2, time: Date.now(), data: { turn: 1, step: 1, message: { id: 'm-9', content: [{ type: 'text', text: '我删掉了它' }] } } })
  h.emit('agent/error', { agent, turn: 1, step: 1, error: new Error('boom') })
  await waitFor(async () => ((await readAt(dir, 'memory/lessons.md')) || '').includes('异步流累积正确'))

  check('异步流文本被正确累积', ((await readAt(dir, 'memory/lessons.md')) || '').includes('异步流累积正确'))
  const calls = h.streamCalls
  check('模型调用收到 signal（超时/取消已接线）', calls.length > 0 && !!calls[0].signal, String(!!calls[0] && !!calls[0].signal))
  check('调用携带默认模型路由', calls.length > 0 && calls[0].provider === 'deepseek-official' && calls[0].model === 'deepseek-flash')
}

// ================= 4. 故障注入：模型失败不丢队列 =================
console.log('\n[4] 故障注入：复盘失败绝不消费待复盘队列')
{
  const dir = join(workdir, 'ws-queue')
  await mkdir(join(dir, 'self-improvement', 'logs'), { recursive: true })
  await writeFile(
    join(dir, 'self-improvement', 'logs', 'session-old.md'),
    '# Session old\n工具调用 3 次，错误 2 次\n\n## Errors\n- boom\n',
    'utf8',
  )
  await writeFile(
    join(dir, 'self-improvement', 'logs', 'pending.md'),
    JSON.stringify({ t: '2026-01-01T00:00:00.000Z', file: 'logs/session-old.md', errors: 2, toolErrors: 1 }) + '\n',
    'utf8',
  )
  const h = makeCtx({
    dir,
    stream: async function* () {
      throw new Error('provider 429 rate limited')
    },
  })
  plugin.apply(h.ctx)
  const agent = h.agent('c4')
  h.roots.push(agent)
  h.emit('agent/session-start', { agent, source: 'startup' })
  await waitFor(async () => /"attempts":1/.test((await readAt(dir, 'logs/pending.md')) || ''))

  const pending = await readAt(dir, 'logs/pending.md')
  check('失败时队列条目保留', !!pending && pending.includes('session-old.md'), JSON.stringify(pending))
  check('失败被记录为尝试次数', !!pending && /"attempts":1/.test(pending), pending || '')
  check('失败原因被记录（不再静默）', !!pending && /lastError/.test(pending))
  const evidence = await readAt(dir, 'logs/session-old.md')
  check('失败时证据文件未被标记已完成', !!evidence && !evidence.includes('[[SELFIP-RETRO-DONE]]'))
}

// ================= 5. 成功才出队 + 去重哨兵 =================
console.log('\n[5] 复盘成功后出队并打完成哨兵')
{
  const dir = join(workdir, 'ws-queue-ok')
  await mkdir(join(dir, 'self-improvement', 'logs'), { recursive: true })
  await writeFile(join(dir, 'self-improvement', 'logs', 'session-ok.md'), '# Session ok\n## Errors\n- oops\n', 'utf8')
  await writeFile(
    join(dir, 'self-improvement', 'logs', 'pending.md'),
    JSON.stringify({ t: '2026-01-01T00:00:00.000Z', file: 'logs/session-ok.md', errors: 1, toolErrors: 0 }) + '\n',
    'utf8',
  )
  const h = makeCtx({ dir, stream: async function* () {
    yield { type: 'text-delta', index: 0, text: '## LESSONS\n- 成功复盘的一次' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } })
  plugin.apply(h.ctx)
  const agent = h.agent('c5')
  h.roots.push(agent)
  h.emit('agent/session-start', { agent, source: 'startup' })
  await waitFor(async () => {
    const text = await readAt(dir, 'logs/session-ok.md')
    return !!text && text.includes('[[SELFIP-RETRO-DONE]]')
  })
  const pending = await readAt(dir, 'logs/pending.md')
  check('成功后队列被消费', !pending || pending.trim() === '', JSON.stringify(pending))
  const evidence = await readAt(dir, 'logs/session-ok.md')
  check('证据文件被打上完成哨兵', !!evidence && evidence.includes('[[SELFIP-RETRO-DONE]]'))
  check('复盘结论已落盘', ((await readAt(dir, 'memory/lessons.md')) || '').includes('成功复盘的一次'))
}

// ================= 6. 已复盘证据去重 + 超过上限转死信 =================
console.log('\n[6] 队列去重与死信转移')
{
  const dir = join(workdir, 'ws-queue-dedup')
  await mkdir(join(dir, 'self-improvement', 'logs'), { recursive: true })
  // 同一会话的两份证据：final 已复盘（带哨兵），partial 未复盘
  await writeFile(join(dir, 'self-improvement', 'logs', 'session-done.md'), '# done\n> [[SELFIP-RETRO-DONE]] @ t\n', 'utf8')
  await writeFile(join(dir, 'self-improvement', 'logs', 'partial-live.md'), '# live\n## Errors\n- still-open\n', 'utf8')
  await writeFile(join(dir, 'self-improvement', 'logs', 'session-dead.md'), '# dead\n', 'utf8')
  await writeFile(
    join(dir, 'self-improvement', 'logs', 'pending.md'),
    [
      JSON.stringify({ t: '2026-01-01T00:00:00.000Z', file: 'logs/session-done.md', errors: 1, toolErrors: 0 }),
      JSON.stringify({ t: '2026-01-01T00:00:00.000Z', file: 'logs/session-dead.md', errors: 9, toolErrors: 9, attempts: 5 }),
    ].join('\n') + '\n',
    'utf8',
  )
  let calls = 0
  const h = makeCtx({
    dir,
    stream: async function* () {
      calls++
      yield { type: 'text-delta', index: 0, text: '## LESSONS\n- 只应复盘一次' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  plugin.apply(h.ctx)
  const agent = h.agent('c6')
  h.roots.push(agent)
  h.emit('agent/session-start', { agent, source: 'startup' })
  await waitFor(async () => (await readAt(dir, 'logs/pending-dead.md')) !== null)
  await sleep(60)
  const pending = (await readAt(dir, 'logs/pending.md')) || ''
  check('已复盘证据被去重出队', !pending.includes('session-done.md'), pending)
  check('超过尝试上限的条目未被再次复盘', !pending.includes('session-dead.md'))
  const dead = await readAt(dir, 'logs/pending-dead.md')
  check('超限条目转入死信队列并留痕', !!dead && dead.includes('session-dead.md'), (dead || '').slice(0, 120))
  const status = JSON.parse(await h.tools.get('selfip_status').execute({}, { agent }))
  check('自诊断暴露死信计数', status.stores[0].pendingDead === 1, JSON.stringify(status.stores[0].pendingDead))
  check('自诊断暴露注入长度（含包装）', status.stores[0].injectionChars >= status.stores[0].memoryCacheChars)
}

// ================= 7. 经验复用范围（可配置：workspace / global / both） =================
console.log('\n[7] 经验复用范围与全局经验库')
{
  // 7.1 纯函数层：优先级与非法值容错
  const env0 = {}
  const defaults = plugin.resolveConfig(null, null, env0)
  check('默认范围是 workspace（不共享）', defaults.scope === 'workspace' && defaults.readGlobal === false, defaults.scope)
  check('默认全局库位于 ${DSH_HOME}/self-improvement', /[\\/]\.dsh[\\/]self-improvement$/.test(defaults.globalDir), defaults.globalDir)
  const byEnv = plugin.resolveConfig({ scope: 'workspace' }, { scope: 'workspace' }, { SELFIP_SCOPE: 'both' })
  check('环境变量优先级最高', byEnv.scope === 'both', byEnv.scope)
  const wsWins = plugin.resolveConfig({ scope: 'global' }, { scope: 'both' }, {})
  check('工作区配置覆盖全局配置', wsWins.scope === 'both', wsWins.scope)
  const bad = plugin.resolveConfig({ scope: 'nonsense' }, null, {})
  check('非法 scope 被忽略并留说明', bad.scope === 'workspace' && bad.notes.length === 1, JSON.stringify(bad.notes))
  // both = 单向复用：读两层，但只写本工作区、不提升（提升即泄露）
  const bothFlags = plugin.resolveConfig(null, { scope: 'both' }, {})
  check(
    'both：读两层 + 只写本工作区 + 不提升',
    bothFlags.readWorkspace === true && bothFlags.readGlobal === true && bothFlags.writeGlobal === false && bothFlags.promote === false,
    'ws=' + bothFlags.readWorkspace + ' g=' + bothFlags.readGlobal + ' wg=' + bothFlags.writeGlobal + ' p=' + bothFlags.promote,
  )
  // 即使 autoPromote=true 也不提升：both 语义下没有"自动提升"这回事
  const bothAuto = plugin.resolveConfig(null, { scope: 'both', autoPromote: true }, {})
  check('both 下 autoPromote=true 仍然不提升（不外流优先）', bothAuto.promote === false, String(bothAuto.promote))
  const wsFlags = plugin.resolveConfig(null, { scope: 'workspace' }, {})
  check(
    'workspace：只读本工作区、不读全局、不提升',
    wsFlags.readWorkspace === true && wsFlags.readGlobal === false && wsFlags.writeGlobal === false && wsFlags.promote === false,
    'ws=' + wsFlags.readWorkspace + ' g=' + wsFlags.readGlobal + ' p=' + wsFlags.promote,
  )
  const glFlags = plugin.resolveConfig(null, { scope: 'global' }, {})
  check(
    'global：只读全局且直接写全局',
    glFlags.readWorkspace === false && glFlags.readGlobal === true && glFlags.writeGlobal === true && glFlags.promote === false,
    'ws=' + glFlags.readWorkspace + ' g=' + glFlags.readGlobal + ' wg=' + glFlags.writeGlobal,
  )
  const expand = plugin.resolveConfig(null, { globalDir: '${DSH_HOME}/exp' }, {})
  check('globalDir 支持 ${DSH_HOME} 占位符', !expand.globalDir.includes('${DSH_HOME}') && expand.globalDir.endsWith('exp'), expand.globalDir)
}

{
  // 7.2 两个独立工作区共用同一个全局库
  const dirA = join(workdir, 'ws-scope-a')
  const dirB = join(workdir, 'ws-scope-b')
  const globalDir = join(workdir, 'global-lib')
  await mkdir(join(dirA, 'self-improvement', 'memory'), { recursive: true })
  await mkdir(join(dirB, 'self-improvement', 'memory'), { recursive: true })
  // 工作区配置文件优先级最高：A 用 global（统一写全局库），B 先用 global 读
  const configOf = (scope) => JSON.stringify({ scope, globalDir }, null, 2) + '\n'
  await writeFile(join(dirA, 'self-improvement', 'config.json'), configOf('global'), 'utf8')
  await writeFile(join(dirB, 'self-improvement', 'config.json'), configOf('global'), 'utf8')

  const hA = makeCtx({ dir: dirA })
  plugin.apply(hA.ctx)
  const agentA = hA.agent('s-a')
  hA.roots.push(agentA)
  hA.emit('agent/session-start', { agent: agentA, source: 'startup' })

  const hB = makeCtx({ dir: dirB })
  plugin.apply(hB.ctx)
  const agentB = hB.agent('s-b')
  hB.roots.push(agentB)
  hB.emit('agent/session-start', { agent: agentB, source: 'startup' })
  await sleep(80)

  const statusA = JSON.parse(await hA.tools.get('selfip_status').execute({}, { agent: agentA }))
  const configA = statusA.stores[0].config
  check('工作区配置文件被读取', configA && configA.scope === 'global' && configA.workspaceConfigExists === true, JSON.stringify(configA && configA.scope))
  check('全局库目录按配置生效', configA && configA.globalDir === globalDir, configA && configA.globalDir)

  const mark = '跨工作区共享经验标记'
  const wrote = await hA.tools.get('remember').execute({ kind: 'method', note: mark, importance: 8 }, { agent: agentA })
  check('global 模式下记忆写入全局库', wrote.ok === true && wrote.scope === 'global', JSON.stringify(wrote))
  const globalSeen = await waitFor(async () => ((await readAt(globalDir, 'memory/methods.md')) || '').includes(mark))
  check('全局库文件确有该条目', globalSeen, 'remember=' + JSON.stringify(wrote) + ' globalDir=' + globalDir)
  const ownA = (await readAt(dirA, 'memory/methods.md')) || ''
  check('工作区库不再重复存放同一条目', !ownA.includes(mark), ownA.slice(0, 80))
  // 自诊断必须在写入之后取值：在写入前取快照只能得到空库
  const statusA2 = JSON.parse(await hA.tools.get('selfip_status').execute({}, { agent: agentA }))
  check(
    '自诊断列出全局库与其条目数',
    statusA2.globalLibraries.length === 1 && statusA2.globalLibraries[0].entries.METHODS >= 1,
    JSON.stringify(statusA2.globalLibraries),
  )

  // 7.3 另一个工作区（不同工作区、零配置改动）即可用到该经验
  const searchB = await hB.tools.get('memory_search').execute({ query: mark }, { agent: agentB })
  check('检索也能跨库命中并标注来源', searchB.count >= 1 && String(searchB.hits[0].file).startsWith('[全局]'), JSON.stringify(searchB.hits[0]))
  // 检索会顺带刷新注入缓存：确认共享经验确实进入了 B 的注入段
  const injectedB = await waitFor(async () => (hB.sections[0].text({ agent: agentB }) || '').includes(mark))
  check('另一工作区注入到共享经验', injectedB, (hB.sections[0].text({ agent: agentB }) || '').slice(0, 120))
  // global 模式下注入的就是共享库本身，段尾标明经验范围
  check('注入段标明经验来自共享库', (hB.sections[0].text({ agent: agentB }) || '').includes('所有工作区共用'))

  // 7.4 切回不共享：立即生效，且不再注入全局内容
  const switched = await hB.tools.get('selfip_config').execute({ scope: 'workspace' }, { agent: agentB })
  check('运行时切换 scope 并落盘', switched.ok === true && switched.scope === 'workspace', JSON.stringify(switched.text).slice(0, 160))
  await waitFor(async () => !(hB.sections[0].text({ agent: agentB }) || '').includes(mark))
  check('切回 workspace 后不再注入其他工作区经验', !(hB.sections[0].text({ agent: agentB }) || '').includes(mark))
}

{
  // 7.5 both：本工作区积累 + 会话结束时提升通用条目到全局库
  //
  // 工作区刻意建在**临时目录之外**：临时目录下的工作区被插件拒绝广播，
  // 否则一次性实验/测试会把条目灌进所有工作区共用的真实全局库（实测踩到过）。
  const outsideRoot = join(dirname(tmpdir()), 'selfip-e2e-' + Date.now().toString(36))
  const dirC = join(outsideRoot, 'ws-scope-c')
  const globalDir = join(outsideRoot, 'global-lib-both')
  await mkdir(join(dirC, 'self-improvement', 'memory'), { recursive: true })
  await mkdir(join(dirC, 'self-improvement', 'logs'), { recursive: true })
  await writeFile(join(dirC, 'self-improvement', 'config.json'), JSON.stringify({ scope: 'both', globalDir }) + '\n', 'utf8')
  // 外部来源条目不得被广播（投毒面放大防护）
  await writeFile(
    join(dirC, 'self-improvement', 'memory', 'facts.md'),
    '- [2026-09-11T00:00:00.000Z] (resource) 外部抓来的资料 {src:web,imp:9}\n',
    'utf8',
  )
  const h = makeCtx({ dir: dirC })
  plugin.apply(h.ctx)
  const agent = h.agent('s-c')
  h.roots.push(agent)
  h.emit('agent/session-start', { agent, source: 'startup' })
  await sleep(60)
  const local = '本地沉淀的通用方法'
  await h.tools.get('remember').execute({ kind: 'method', note: local, importance: 9 }, { agent: agent })
  const own = (await readAt(dirC, 'memory/methods.md')) || ''
  check('both 模式下先写本工作区库', own.includes(local), own.slice(0, 80))

  // 会话收尾在 agent/disposed 上执行（不是 session-end）：落盘挂在那个事件
  h.emit('agent/session-end', { agent })
  h.emit('agent/disposed', { agent })
  await sleep(900)
  const shared = (await readAt(globalDir, 'memory/methods.md')) || ''
  // both 的语义是"单向复用"：读得到其他工作区的经验，但本工作区的经验只留在本地、不外流。
  // 所以这里断言的是**不提升**——旧断言"提升到全局库"正是现在要禁止的泄露行为。
  check('both 模式下通用条目不外流到全局库', !shared.includes(local), shared.slice(0, 120) || '(全局库无内容)')
  check('本工作区条目仍留在本地库', ((await readAt(dirC, 'memory/methods.md')) || '').includes(local))
  check('全局库没有提升标记', !/promoted:/.test(shared), shared.slice(0, 160) || '(空)')
  check('外部来源条目不被广播（保持不变）', !shared.includes('外部抓来的资料'), shared.slice(0, 200) || '(空)')
  check('仅记过一条经验的会话也会落盘日志', (await readAt(dirC, 'logs/pending.md')) !== null, String(await readAt(dirC, 'logs/pending.md')).slice(0, 120))
  rmSync(outsideRoot, { recursive: true, force: true })
}

{
  // 7.6 临时工作区不得广播：测试与一次性实验都建在 TEMP 下，它们不能污染真实全局库
  const dirT = join(workdir, 'ws-temp-guard')
  const globalGuard = join(workdir, 'global-lib-guard')
  await mkdir(join(dirT, 'self-improvement', 'memory'), { recursive: true })
  await mkdir(join(dirT, 'self-improvement', 'logs'), { recursive: true })
  await writeFile(join(dirT, 'self-improvement', 'config.json'), JSON.stringify({ scope: 'both', globalDir: globalGuard }) + '\n', 'utf8')
  const h = makeCtx({ dir: dirT })
  plugin.apply(h.ctx)
  const agent = h.agent('s-guard')
  h.roots.push(agent)
  h.emit('agent/session-start', { agent, source: 'startup' })
  await sleep(60)
  await h.tools.get('remember').execute({ kind: 'method', note: '测试工作区的临时方法', importance: 10 }, { agent: agent })
  h.emit('agent/disposed', { agent })
  await sleep(400)
  const leaked = (await readAt(globalGuard, 'memory/methods.md')) || ''
  check('临时工作区的条目不会被提升到共享库', !leaked.includes('测试工作区的临时方法'), leaked.slice(0, 120))
  check('工作区库仍正常写入', ((await readAt(dirT, 'memory/methods.md')) || '').includes('测试工作区的临时方法'))
}

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败'))
rmSync(workdir, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
