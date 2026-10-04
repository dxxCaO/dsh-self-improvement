/**
 * 内容时效性（volatility）与凭据脱敏测试。
 *
 * 背景：现实里有一类记忆会**因为外部世界变化而失效**，而不是因为"旧"。最典型的是
 * 凭据——当时好使的 API key 现在被删了。此前插件对这两件事都没有处理：
 *   - 凭据明文会被写进记忆，随注入进入每次会话的系统提示，并可能扩散到共享库；
 *   - 所有条目共用同一条新鲜度曲线（5→1），既不会失效、也不会提示重验。
 *
 * 修复后的关键语义：**到期不删除、只标"可能已失效"**。
 * 单纯让它消失会把"这个 key 已被吊销"这一结论一起丢掉，模型下次反而重新踩坑。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
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

const root = mkdtempSync(join(tmpdir(), 'selfip-stale-'))
process.env.DSH_HOME = join(root, 'home')
const plugin = await import('data:text/javascript;base64,' + Buffer.from(patched, 'utf8').toString('base64'))

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  [' + detail + ']' : ''))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 摘出纯函数（保证测的是在跑的代码）----
const credCode = source.slice(source.indexOf('const CREDENTIAL_PATTERNS'), source.indexOf('/**\n * 内容时效性'))
const cred = new Function(credCode + '\n; return { redactCredentials };')()

// volatilityOf / isStaleEntry 在模块作用域
const ttlCode = source.slice(source.indexOf('const TTL_RULES'), source.indexOf('/** 已过期待重验的标记'))
const ttl = new Function(
  "const SENTINEL_INVALID='invalid';\n" + ttlCode + '\n; return { volatilityOf, isStaleEntry, TTL_DEFAULT_DAYS };',
)()

console.log('\n[1] 凭据脱敏：已知形态必须被盖掉')
{
  const must = [
    ['github token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij', 'ghp'],
    ['OpenAI key: sk-proj-abcdefghijklmnopqrstuvwxyz123456', 'sk'],
    ['AWS api_key = AKIAIOSFODNN7EXAMPLE', 'AKIA'],
    ['secret: "abcdefghijklmnop1234"', null],
    ['密钥：abcdefgh12345678', null],
    ['password = "MyS3cretP@ssw0rd123"', null],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'eyJ'],
  ]
  for (const [text] of must) {
    const r = cred.redactCredentials(text)
    check('脱敏：' + text.slice(0, 32), !!r.redacted && !/ghp_[A-Za-z0-9]{20}|sk-[A-Za-z0-9]{20}|AKIA[0-9A-Z]{12}|abcdefghijklmnop1234|abcdefgh12345678|MyS3cret/.test(r.redacted), JSON.stringify((r.redacted || text).slice(0, 60)))
  }
}

console.log('\n[2] 凭据脱敏不误伤正常文本（反向断言）')
{
  const mustNot = [
    '用户偏好用中文沟通（不含凭据）',
    '见 https://github.com/settings/tokens 管理',
    'token 只记录"用完即撤销"这条流程，不记值',
    '模型名 deepseek-flash，provider deepseek-official',
    '端点 https://api.example.com/v1 已变更',
    '记忆注入上限 3200 字符',
  ]
  for (const text of mustNot) {
    const r = cred.redactCredentials(text)
    check('不误伤：' + text.slice(0, 26), r.redacted === null, JSON.stringify(r.redacted || '').slice(0, 50))
  }
}

console.log('\n[3] 时效推断：易变内容复查周期更短')
{
  check('含 api key 的字样 -> 30 天', ttl.volatilityOf('云端 API key 已配置好') === 30, String(ttl.volatilityOf('云端 API key 已配置好')))
  check('含端点/模型名 -> 90 天', ttl.volatilityOf('服务端点是 https://x.example.com') === 90, String(ttl.volatilityOf('服务端点是 https://x.example.com')))
  check('含 URL/服务 -> 180 天', ttl.volatilityOf('用这个平台管理订阅') === 180, String(ttl.volatilityOf('用这个平台管理订阅')))
  check('普通偏好 -> 默认 180 天', ttl.volatilityOf('用户偏好先写方案再改代码') === ttl.TTL_DEFAULT_DAYS, String(ttl.volatilityOf('用户偏好先写方案再改代码')))
}

console.log('\n[4] isStaleEntry：到期判定')
{
  const now = Date.now()
  const old = new Date(now - 200 * 86400000).toISOString()
  const fresh = new Date(now - 1 * 86400000).toISOString()
  check('30 天 TTL + 200 天前确认 -> 已过期', ttl.isStaleEntry({ ts: old, meta: { ttl: '30', vfy: old } }, now) === true)
  check('30 天 TTL + 1 天前确认 -> 未过期', ttl.isStaleEntry({ ts: fresh, meta: { ttl: '30', vfy: fresh } }, now) === false)
  check('无 ttl 的老条目 -> 不判过期（兼容历史数据）', ttl.isStaleEntry({ ts: old, meta: {} }, now) === false)
  check('有 ttl 但无 vfy -> 回退用写入时间 ts', ttl.isStaleEntry({ ts: old, meta: { ttl: '30' } }, now) === true)
}

// ---- 端到端 harness ----
async function harness(ws, agentId) {
  const listeners = new Map()
  const tools = new Map()
  const roots = []
  const sections = []
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
      writeFileSync(target.targetKey, String(content), 'utf8')
      return { operation: 'update', version: 'v', before: null, after: String(content) }
    },
    async listDir(target) {
      const { readdir } = await import('node:fs/promises')
      const entries = await readdir(target.targetKey, { withFileTypes: true })
      return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file', target: { targetKey: join(target.targetKey, e.name) } }))
    },
  }
  const ctx = {
    fs: fsStub,
    llm: { stream: () => (async function* () {})() },
    systemPrompt: { section: (s) => { sections.push(s); return () => {} } },
    timer: { timeout: (cb, ms) => { const h = setTimeout(cb, Math.min(ms, 30)); return () => clearTimeout(h) } },
    sandboxPolicy: { workspaceRoot: '/', resolve: () => ({ mode: 'danger-full-access', workspaceRoot: ws, sessionId: agentId }) },
    tools: { register: (d) => { tools.set(d.name, d); return () => {} } },
    commands: { register: () => () => {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on: (e, f) => { const l = listeners.get(e) || []; l.push(f); listeners.set(e, l); return () => {} },
    get(name) {
      if (name === 'agents') return { roots: () => roots }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return undefined
    },
  }
  const agent = { id: agentId, session: { id: agentId, header: { cwd: ws } } }
  roots.push(agent)
  plugin.apply(ctx)
  for (const l of listeners.get('agent/session-start') || []) l({ agent, source: 'startup' })
  await sleep(150)
  return {
    agent,
    tools,
    injected: () => sections.map((s) => (typeof s.text === 'function' ? s.text({ agent }) : s.text)).join('\n'),
  }
}

function makeWs(tag) {
  const ws = join(root, 'ws-' + tag)
  mkdirSync(join(ws, 'self-improvement', 'memory'), { recursive: true })
  mkdirSync(join(ws, 'self-improvement', 'logs'), { recursive: true })
  return ws
}

console.log('\n[5] 端到端：写入时自动打 ttl/vfy，凭据自动脱敏')
{
  const ws = makeWs('write')
  const h = await harness(ws, 'stale-1')
  await h.tools.get('remember').execute({ kind: 'fact', note: '云端 API key：sk-proj-abcdefghijklmnopqrstuvwxyz123456', importance: 7 }, { agent: h.agent })
  await h.tools.get('remember').execute({ kind: 'fact', note: '用户偏好先写方案再改代码', importance: 8 }, { agent: h.agent })
  await sleep(200)
  const content = readFileSync(join(ws, 'self-improvement', 'memory', 'facts.md'), 'utf8')
  check('明文 key 未落盘', !content.includes('sk-proj-abcdefghijklmnopqrstuvwxyz123456'), content.includes('sk-proj-abc') ? 'LEAKED' : 'clean')
  check('脱敏标记已写入', /已脱敏/.test(content))
  check('key 类条目 ttl=30', /ttl:30/.test(content), (content.match(/ttl:\d+/g) || []).join(','))
  check('普通偏好 ttl=180', /ttl:180/.test(content))
  check('都带了 vfy（上次确认时间）', (content.match(/vfy:/g) || []).length >= 2, String((content.match(/vfy:/g) || []).length))
}

console.log('\n[6] 端到端：过期条目仍注入，但带"可能已失效"标记')
{
  const ws = makeWs('stale-inject')
  const old = new Date(Date.now() - 200 * 86400000).toISOString()
  // 一条已过期的 key 类条目（ttl=30，200 天前确认）
  const staleLine = '- [' + old + '] (fact) 当时好使的云端 key 是 <已脱敏:sk>，服务商为 X {origin:tool,imp:7,ttl:30,vfy:' + old + '}'
  const freshLine = '- [' + new Date().toISOString() + '] (fact) 用户偏好先写方案再改代码 {origin:tool,imp:8,ttl:180,vfy:' + new Date().toISOString() + '}'
  writeFileSync(join(ws, 'self-improvement', 'memory', 'facts.md'), staleLine + '\n' + freshLine + '\n', 'utf8')
  const h = await harness(ws, 'stale-2')
  const text = h.injected()
  check('过期条目仍在注入里（不隐藏）', text.includes('当时好使的云端 key'), text.includes('当时好使') ? 'present' : 'MISSING')
  check('过期条目带"可能已失效"标记', /可能已失效/.test(text))
  check('有效期内的条目不带该标记', !/先写方案再改代码[^\n]*可能已失效/.test(text))
  // 重要：过期条目被降权，不该压过有效条目
  const staleIdx = text.indexOf('当时好使的云端 key')
  const freshIdx = text.indexOf('先写方案再改代码')
  check('有效条目排在过期条目之前（过期被降权）', freshIdx >= 0 && staleIdx >= 0 && freshIdx < staleIdx, 'fresh@' + freshIdx + ' stale@' + staleIdx)
}

console.log('\n[7] 睡眠巩固会收到"待重验清单"')
{
  const ws = makeWs('sleep-stale')
  const old = new Date(Date.now() - 300 * 86400000).toISOString()
  writeFileSync(
    join(ws, 'self-improvement', 'memory', 'facts.md'),
    '- [' + old + '] (fact) 旧端点是 https://old.example.com/v1 {origin:tool,imp:6,ttl:90,vfy:' + old + '}\n',
    'utf8',
  )
  const ws2 = ws
  let captured = null
  const listeners = new Map()
  const roots = []
  const fsStub = {
    async resolve(p, o) {
      const base = o && o.cwd ? o.cwd : process.cwd()
      return { targetKey: /^([A-Za-z]:|[\\/])/.test(p) ? p : join(base, p), displayPath: p }
    },
    async readText(t) {
      return await readFile(t.targetKey, 'utf8')
    },
    async writeText(t, c) {
      await mkdir(join(t.targetKey, '..'), { recursive: true })
      writeFileSync(t.targetKey, String(c), 'utf8')
      return { operation: 'update', version: 'v', before: null, after: String(c) }
    },
    async listDir() {
      return []
    },
  }
  const ctx = {
    fs: fsStub,
    llm: {
      stream(options) {
        captured = options
        return (async function* () {})()
      },
    },
    systemPrompt: { section: () => () => {} },
    timer: { timeout: (cb, ms) => { const hh = setTimeout(cb, Math.min(ms, 30)); return () => clearTimeout(hh) } },
    sandboxPolicy: { workspaceRoot: '/', resolve: () => ({ mode: 'danger-full-access', workspaceRoot: ws2, sessionId: 'sl' }) },
    tools: { register: () => () => {} },
    commands: { register: () => () => {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on: (e, f) => { const l = listeners.get(e) || []; l.push(f); listeners.set(e, l); return () => {} },
    get(name) {
      if (name === 'agents') return { roots: () => roots }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return undefined
    },
  }
  const agent = { id: 'sl-1', session: { id: 'sl-1', header: { cwd: ws2 } } }
  roots.push(agent)
  plugin.apply(ctx)
  for (const l of listeners.get('agent/session-start') || []) l({ agent, source: 'startup' })
  // 等睡眠巩固发起调用（它有自己的冷却与调度）
  for (let i = 0; i < 60 && !captured; i++) await sleep(100)
  if (!captured) {
    check('睡眠巩固已发起调用（前置条件）', false, '未捕获到 llm.stream 调用')
  } else {
    const userText = JSON.stringify((captured.messages || []).map((m) => m.content))
    check('调用里含"待重验条目"段', /待重验条目/.test(userText))
    check('待重验段列出了过期条目', /old\.example\.com/.test(userText))
    check('系统提示要求核实失效（不是直接复述）', /不要把过期的值当作仍然有效/.test(String(captured.system || '')) || /时效核实/.test(String(captured.system || '')))
  }
}

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败'))
rmSync(root, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
