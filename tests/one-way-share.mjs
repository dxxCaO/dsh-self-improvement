/**
 * both = 工作区 + 全局只读（单向复用）语义测试。
 *
 * 需求原话："可以复用这个工作区和其他工作区所有的经验，但其他工作区不能用这个经验区的经验。"
 * 即：本工作区 ← 全局库（读），本工作区 → 全局库（**不写、不提升**）。
 *
 * 本文件用两个独立工作区共用同一个全局库，直接验证这条承诺：
 *   A（both）沉淀的经验，不得出现在 B 的注入里，也不得出现在全局库里。
 * 同时验证 A 确实能读到别的来源写进全局库的经验。
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

const root = mkdtempSync(join(tmpdir(), 'selfip-oneway-'))
process.env.DSH_HOME = join(root, 'home')

const plugin = await import('data:text/javascript;base64,' + Buffer.from(patched, 'utf8').toString('base64'))

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  [' + detail + ']' : ''))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const memLine = (text) => '- [2026-09-11T10:00:00.000Z] (method) ' + text + ' {origin:tool,imp:9}\n'
const readAt = (dir, rel) => {
  try {
    return readFileSync(join(dir, 'self-improvement', rel), 'utf8')
  } catch {
    return ''
  }
}
const globalReadAt = (globalDir, rel) => {
  try {
    return readFileSync(join(globalDir, 'self-improvement', rel), 'utf8')
  } catch {
    return ''
  }
}

/** 建一个工作区（可选 scope 配置） */
function makeWorkspace(tag, scope, globalDir) {
  const ws = join(root, 'ws-' + tag)
  mkdirSync(join(ws, 'self-improvement', 'memory'), { recursive: true })
  mkdirSync(join(ws, 'self-improvement', 'logs'), { recursive: true })
  if (scope) {
    writeFileSync(
      join(ws, 'self-improvement', 'config.json'),
      JSON.stringify({ scope, globalDir, autoPromote: true }, null, 2) + '\n',
      'utf8',
    )
  }
  return ws
}

/** 起一个插件实例，返回 harness */
async function harnessFor(ws, globalDir, agentId) {
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
  await sleep(120)
  return {
    agent,
    remember: tools.get('remember'),
    emit: (ev, payload) => { for (const l of listeners.get(ev) || []) l(payload) },
    injected: () => sections.map((s) => (typeof s.text === 'function' ? s.text({ agent }) : s.text)).join('\n'),
  }
}

const globalDir = join(root, 'home', 'self-improvement')
mkdirSync(join(globalDir, 'self-improvement', 'memory'), { recursive: true })
// 全局库里放一条"来自别处"的经验（模拟其他工作区/手工维护的公共经验）
writeFileSync(join(globalDir, 'self-improvement', 'memory', 'methods.md'), memLine('公共经验：其他工作区沉淀的方法'), 'utf8')

console.log('\n[1] both（工作区 + 全局只读）：能读到全局库的经验')
{
  const wsA = makeWorkspace('a', 'both', globalDir)
  writeFileSync(join(wsA, 'self-improvement', 'memory', 'methods.md'), memLine('本工作区自己的方法'), 'utf8')
  const h = await harnessFor(wsA, globalDir, 'a1')
  const text = h.injected()
  check('注入含本工作区经验', text.includes('本工作区自己的方法'))
  check('注入含全局库经验（复用其他工作区）', text.includes('公共经验：其他工作区沉淀的方法'))
  check('注入说明标出单向复用', /不外流|不会外流/.test(text), (text.match(/经验范围：[^\n]*/) || [''])[0])
}

console.log('\n[2] 单向承诺：A 在 both 下沉淀的经验不外流')
{
  const wsA = join(root, 'ws-a') // 复用 [1] 建好的目录
  const h = await harnessFor(wsA, globalDir, 'a2')
  const secret = 'A的私有经验不应外流'
  const res = await h.remember.execute({ kind: 'method', note: secret, importance: 9 }, { agent: h.agent })
  check('remember 成功', res && res.ok === true, JSON.stringify(res).slice(0, 120))
  check('写进了本工作区库', readAt(wsA, 'memory/methods.md').includes(secret))
  h.emit('agent/session-end', { agent: h.agent })
  h.emit('agent/disposed', { agent: h.agent })
  await sleep(900)
  const globalText = globalReadAt(globalDir, 'memory/methods.md')
  check('全局库里没有 A 的经验（不外流）', !globalText.includes(secret), globalText.slice(0, 100) || '(空)')
  check('全局库里仍只有那条公共经验', globalText.includes('公共经验：其他工作区沉淀的方法'))
}

console.log('\n[3] 其他工作区看不到 A 的经验（同一全局库）')
{
  const wsB = makeWorkspace('b', 'both', globalDir)
  const hB = await harnessFor(wsB, globalDir, 'b1')
  const textB = hB.injected()
  check('B 能读到全局库的公共经验', textB.includes('公共经验：其他工作区沉淀的方法'))
  check('B 读不到 A 的私有经验', !textB.includes('A的私有经验不应外流'))
  check('B 的本工作区库为空（未误写）', !readAt(wsB, 'memory/methods.md').includes('A的私有经验'))
}

console.log('\n[4] 手动提升在 both 下被拒绝（提升即泄露）')
{
  // both 下 promoteToGlobal 必须直接返回 blockedByScope，连 force（手动 /promote）也不能绕过。
  // 这里断言派生开关；force 路径的守卫在 index.js 的 promoteToGlobal 顶部。
  const cfg = plugin.resolveConfig(null, { scope: 'both', autoPromote: true }, {})
  check('both 的 promote 开关为 false', cfg.promote === false, String(cfg.promote))
  check('both 读两层（确认不是 workspace）', cfg.readWorkspace === true && cfg.readGlobal === true)
  const gcfg = plugin.resolveConfig(null, { scope: 'global' }, {})
  check('global 也不走提升（本就是直接写全局库）', gcfg.promote === false && gcfg.writeGlobal === true)
}

console.log('\n[5] 对照：global 模式下经验确实共享（保证没把共享整体改坏）')
{
  const wsG = makeWorkspace('g', 'global', globalDir)
  const hG = await harnessFor(wsG, globalDir, 'g1')
  const shared = 'G写进公共库的经验'
  await hG.remember.execute({ kind: 'method', note: shared, importance: 9 }, { agent: hG.agent })
  await sleep(300)
  check('global 模式下写入直达全局库', globalReadAt(globalDir, 'memory/methods.md').includes(shared))
  // 另一个工作区能看到它
  const wsH = makeWorkspace('h', 'global', globalDir)
  const hH = await harnessFor(wsH, globalDir, 'h1')
  check('另一个工作区能看到 global 模式写入的经验', hH.injected().includes(shared))
}

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败'))
rmSync(root, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
