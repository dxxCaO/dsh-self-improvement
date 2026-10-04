/**
 * 面板「记忆库」范围一致性测试（单进程单实例）。
 *
 * 背景：global（全部共用）模式下，插件的注入与检索都取自**全局库**，本工作区库完全不参与。
 * 但面板的显示与写入曾固定按 cwd 走，于是出现：
 *   - 在新建工作区打开面板 → 显示「0 条 / 还没有沉淀任何记忆」，而运行状态却显示全局库有几十条
 *   - 在面板里「加一条 / 作废」→ 写进本工作区库，而真正生效的全局库毫发无损（界面报成功）
 *
 * 本测试直接驱动面板路由，断言 global 模式下读写的都是**全局库**。
 * 需要一个真实的 HTTP 服务器来接收 register 的路由，因此用 node:http 起一个临时端口。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

const sourcePath = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const source = await readFile(sourcePath, 'utf8')
const patched = source.replace(
  "import { defineTool } from '@deepseek-ai/dsh-tools'",
  'const defineTool = (options) => options',
)
const plugin = await import('data:text/javascript;base64,' + Buffer.from(patched, 'utf8').toString('base64'))

const root = mkdtempSync(join(tmpdir(), 'selfip-panel-'))
process.env.DSH_HOME = join(root, 'home')

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  [' + detail + ']' : ''))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const memLine = (i, text) =>
  '- [2026-09-11T10:00:00.000Z] (lesson) ' + text + ' {origin:tool,imp:8,uses:' + (i % 3) + '}\n'

/** 起一个真实 HTTP 服务，把 /selfip 前缀路由交给插件注册的 handler */
function startServer() {
  return new Promise((resolve) => {
    const handlerRef = { fn: null }
    const server = http.createServer((req, res) => {
      if (handlerRef.fn) handlerRef.fn(req, res)
      else {
        res.statusCode = 404
        res.end('no handler')
      }
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, handlerRef, port: server.address().port }))
  })
}

const post = (port, path, body) =>
  fetch('http://127.0.0.1:' + port + '/selfip' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json())

const getState = (port, sid) =>
  fetch('http://127.0.0.1:' + port + '/selfip/state?sessionId=' + encodeURIComponent(sid)).then((r) => r.json())

/** 建工作区 + 全局库，各放若干条；工作区配置 scope=global */
function seed() {
  const ws = join(root, 'ws-' + Math.random().toString(36).slice(2, 9))
  const globalDir = join(root, 'home', 'self-improvement')
  mkdirSync(join(ws, 'self-improvement', 'memory'), { recursive: true })
  mkdirSync(join(ws, 'self-improvement', 'logs'), { recursive: true })
  mkdirSync(join(globalDir, 'self-improvement', 'memory'), { recursive: true })
  // 本工作区库：3 条
  writeFileSync(
    join(ws, 'self-improvement', 'memory', 'lessons.md'),
    Array.from({ length: 3 }, (_, i) => memLine(i, '本工作区教训' + i)).join(''),
    'utf8',
  )
  // 全局库：7 条（模拟"其他工作区"的沉淀）
  writeFileSync(
    join(globalDir, 'self-improvement', 'memory', 'lessons.md'),
    Array.from({ length: 7 }, (_, i) => memLine(i, '其他工作区经验' + i)).join(''),
    'utf8',
  )
  writeFileSync(
    join(ws, 'self-improvement', 'config.json'),
    JSON.stringify({ scope: 'global', globalDir: globalDir, autoPromote: true }, null, 2) + '\n',
    'utf8',
  )
  return { ws, globalDir }
}

async function harness(ws, globalDir, port, handlerRef) {
  const listeners = new Map()
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
      writeFileSync(target.targetKey, String(content), 'utf8')
      return { operation: 'update', version: 'v', before: null, after: String(content) }
    },
    async listDir(target) {
      const { readdir } = await import('node:fs/promises')
      const entries = await readdir(target.targetKey, { withFileTypes: true })
      return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file', target: { targetKey: join(target.targetKey, e.name) } }))
    },
  }
  const webServer = { register: (route) => { handlerRef.fn = route.handler; return () => {} } }
  const ctx = {
    fs: fsStub,
    llm: { stream: () => (async function* () {})() },
    systemPrompt: { section: () => () => {} },
    timer: { timeout: (cb, ms) => { const h = setTimeout(cb, Math.min(ms, 30)); return () => clearTimeout(h) } },
    sandboxPolicy: { workspaceRoot: '/', resolve: () => ({ mode: 'danger-full-access', workspaceRoot: ws, sessionId: 's' }) },
    tools: { register: () => () => {} },
    commands: { register: () => () => {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on: (e, f) => { const l = listeners.get(e) || []; l.push(f); listeners.set(e, l); return () => {} },
    get(name) {
      if (name === 'agents') return { roots: () => roots }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      if (name === 'fs') return fsStub
      if (name === 'webServer') return webServer
      if (name === 'sandboxPolicy') return ctx.sandboxPolicy
      // 面板靠 sessions.get(sessionId).header.cwd 解析"当前会话工作区"
      if (name === 'sessions') return { get: (sid) => (String(sid) === String(agent.id) ? { id: agent.id, header: { cwd: ws } } : undefined) }
      return undefined
    },
  }
  const agent = { id: 'panel-1', session: { id: 'panel-1', header: { cwd: ws } } }
  roots.push(agent)
  plugin.apply(ctx)
  // 触发 session-start 以建立该工作区 store（面板路由依赖 stores.get(cwd)）
  for (const l of listeners.get('agent/session-start') || []) l({ agent, source: 'startup' })
  await sleep(150)
  return { agent }
}

console.log('\n[1] global 模式下：面板显示"实际生效的库"= 全局库')
{
  const { server, handlerRef, port } = await startServer()
  const { ws, globalDir } = seed()
  const h = await harness(ws, globalDir, port, handlerRef)
  const st = await getState(port, h.agent.id)
  check('面板可用', st.ok === true, String(st.ok))
  check('scope 被解析为 global', st.scope === 'global', String(st.scope))
  check('标记出实际生效的是全局库', st.effectiveIsGlobal === true, String(st.effectiveIsGlobal))
  check('卡片标题标明全局库', /全局库/.test(String(st.effectiveLabel)), String(st.effectiveLabel))
  const globalLessons = (st.global && st.global.sections.find((s) => s.key === 'LESSONS')) || {}
  const wsLessons = (st.workspace && st.workspace.sections.find((s) => s.key === 'LESSONS')) || {}
  check('全局库确实有 7 条（模拟其他工作区沉淀）', globalLessons.count === 7, String(globalLessons.count))
  check('本工作区库只有 3 条', wsLessons.count === 3, String(wsLessons.count))
  server.close()
  rmSync(ws, { recursive: true, force: true })
}

console.log('\n[2] global 模式下：面板"加一条"写入全局库（不是本工作区库）')
{
  const { server, handlerRef, port } = await startServer()
  const { ws, globalDir } = seed()
  const h = await harness(ws, globalDir, port, handlerRef)
  const wsFile = join(ws, 'self-improvement', 'memory', 'lessons.md')
  const glFile = join(globalDir, 'self-improvement', 'memory', 'lessons.md')
  const wsBefore = readFileSync(wsFile, 'utf8')
  const glBefore = readFileSync(glFile, 'utf8')

  const res = await post(port, '/memory', { action: 'add', section: 'LESSONS', text: '面板新增的一条全局经验', sessionId: h.agent.id })
  check('写入成功', res.ok === true, JSON.stringify(res).slice(0, 120))
  check('写到了全局库', readFileSync(glFile, 'utf8').includes('面板新增的一条全局经验'))
  check('本工作区库未被改动', readFileSync(wsFile, 'utf8') === wsBefore)
  check('返回里标明了目标库', String(res.target || '') === globalDir, String(res.target))
  check('全局库条目数 +1', readFileSync(glFile, 'utf8').length > glBefore.length)
  server.close()
  rmSync(ws, { recursive: true, force: true })
}

console.log('\n[3] global 模式下：面板"作废"作用于全局库条目')
{
  const { server, handlerRef, port } = await startServer()
  const { ws, globalDir } = seed()
  const h = await harness(ws, globalDir, port, handlerRef)
  const glFile = join(globalDir, 'self-improvement', 'memory', 'lessons.md')
  // 作废一条只存在于全局库的条目（模拟用户想清理其他工作区带来的经验）
  const res = await post(port, '/memory', { action: 'invalidate', section: 'LESSONS', text: '其他工作区经验5', sessionId: h.agent.id })
  check('作废成功', res.ok === true && res.hits >= 1, JSON.stringify(res).slice(0, 140))
  const after = readFileSync(glFile, 'utf8')
  check('全局库里该条被标记 invalid', /其他工作区经验5[^\n]*invalid:/.test(after), 'marker check')
  check('原文未被删除（双时态）', after.includes('其他工作区经验5'))
  server.close()
  rmSync(ws, { recursive: true, force: true })
}

console.log('\n[4] workspace 模式下：仍然读写本工作区库（不能改坏原行为）')
{
  const { server, handlerRef, port } = await startServer()
  const { ws, globalDir } = seed()
  // 覆盖为 workspace
  writeFileSync(
    join(ws, 'self-improvement', 'config.json'),
    JSON.stringify({ scope: 'workspace', globalDir: globalDir, autoPromote: true }, null, 2) + '\n',
    'utf8',
  )
  const h = await harness(ws, globalDir, port, handlerRef)
  const st = await getState(port, h.agent.id)
  check('effectiveIsGlobal 为 false', st.effectiveIsGlobal === false, String(st.effectiveIsGlobal))
  const wsFile = join(ws, 'self-improvement', 'memory', 'lessons.md')
  const glFile = join(globalDir, 'self-improvement', 'memory', 'lessons.md')
  const glBefore = readFileSync(glFile, 'utf8')
  const res = await post(port, '/memory', { action: 'add', section: 'LESSONS', text: '工作区模式新增的一条', sessionId: h.agent.id })
  check('写入成功', res.ok === true, JSON.stringify(res).slice(0, 120))
  check('写到了本工作区库', readFileSync(wsFile, 'utf8').includes('工作区模式新增的一条'))
  check('全局库未被改动', readFileSync(glFile, 'utf8') === glBefore)
  server.close()
  rmSync(ws, { recursive: true, force: true })
}

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败'))
rmSync(root, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
