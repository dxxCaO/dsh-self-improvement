/**
 * 对抗性审计发现的缺陷 → 回归测试。
 *
 * 来源：一次独立子代理审计（脚本在 pub/audit/）。这里把**经我复核确认**的几条
 * 固化成断言，防止再次退化。特别地，原有的 panel-scope / parser-tolerance 恰好
 * 绕过了这些点，所以这份文件补的是它们漏掉的交叉验证。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
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

const root = mkdtempSync(join(tmpdir(), 'selfip-audit-'))
process.env.DSH_HOME = join(root, 'home')
const plugin = await import('data:text/javascript;base64,' + Buffer.from(patched, 'utf8').toString('base64'))

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  [' + detail + ']' : ''))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const memLine = (text, meta) => '- [2026-09-12T04:00:00.000Z] (lesson) ' + text + ' {' + (meta || 'origin:tool,imp:5') + '}'

// ---------- HTTP 面板 harness ----------
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
const get = (port, path) => fetch('http://127.0.0.1:' + port + '/selfip' + path).then((r) => r.json())

async function harness(ws, agentId) {
  const { server, handlerRef, port } = await startServer()
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
    timer: { timeout: (cb, ms) => { const hh = setTimeout(cb, Math.min(ms, 30)); return () => clearTimeout(hh) } },
    sandboxPolicy: { workspaceRoot: '/', resolve: () => ({ mode: 'danger-full-access', workspaceRoot: ws, sessionId: agentId }) },
    tools: { register: (d) => { tools.set(d.name, d); return () => {} } },
    commands: { register: () => () => {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on: (e, f) => { const l = listeners.get(e) || []; l.push(f); listeners.set(e, l); return () => {} },
    get(name) {
      if (name === 'agents') return { roots: () => roots }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      if (name === 'fs') return fsStub
      if (name === 'webServer') return webServer
      if (name === 'sandboxPolicy') return ctx.sandboxPolicy
      if (name === 'sessions') return { get: (sid) => (String(sid) === String(agentId) ? { id: agentId, header: { cwd: ws } } : undefined) }
      return undefined
    },
  }
  const agent = { id: agentId, session: { id: agentId, header: { cwd: ws } } }
  roots.push(agent)
  plugin.apply(ctx)
  for (const l of listeners.get('agent/session-start') || []) l({ agent, source: 'startup' })
  await sleep(150)
  return { agent, tools, port, server }
}

function makeWs(tag) {
  const ws = join(root, 'ws-' + tag)
  mkdirSync(join(ws, 'self-improvement', 'memory'), { recursive: true })
  mkdirSync(join(ws, 'self-improvement', 'logs'), { recursive: true })
  return ws
}

// ---------- 从源码摘出纯函数（保证测的是在跑的代码）----------
const grab = (from, to) => source.slice(source.indexOf(from), source.indexOf(to))
const { splitSections, normalizeSectionKey } = new Function(
  grab('  const SECTION_ALIASES', '  function extractCodeBlock') + '\n; return { splitSections, normalizeSectionKey };',
)()
const { tokenize } = new Function(
  grab('  const segmenter = (() => {', '  /**\n   * BM25 相关性') + '\n; return { tokenize };',
)()

console.log('\n[F4] 裸 PLAYBOOK: 格式与中文 slug')
{
  const bare = Object.keys(splitSections('PLAYBOOK:my-flow\n步骤 A'))
  check('裸 PLAYBOOK:slug 能解析', bare.join() === 'PLAYBOOK:my-flow', JSON.stringify(bare))
  const full = Object.keys(splitSections('PLAYBOOK：中文名\n步骤'))
  check('全角冒号也能解析', full.join() === 'PLAYBOOK:中文名', JSON.stringify(full))
  check('## PLAYBOOK:slug 仍可解析（不回归）', Object.keys(splitSections('## PLAYBOOK:x\n-y')).join() === 'PLAYBOOK:x')
  const noise = Object.keys(splitSections('注意：这里有正文\n步骤：\n- a'))
  check('正文里的"注意：""步骤："不被误切', noise.length === 0, JSON.stringify(noise))
  const slug = '修复沙箱写入'.toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  check('纯中文 slug 保留（不再被清成空串）', slug.length > 0, slug)
  check('normalizeSectionKey 对 PLAYBOOK 分支不再被用到（改由 splitSections 处理）', normalizeSectionKey('LESSONS') === 'LESSONS')
}

console.log('\n[F7] 连续中文单字要补 bigram')
{
  const tokens = tokenize('沙箱围栏')
  check('「沙箱围栏」切出 bigram（不再退化为纯单字）', tokens.has('沙箱') && tokens.has('围栏'), JSON.stringify([...tokens]))
  const entry = tokenize('沙箱围栏会拒绝工作区外的写入')
  check('条目侧同样含「围栏」词项', entry.has('围栏'))
  let overlap = false
  for (const t of tokenize('完全不相干的关键词xyz')) if (entry.has(t)) overlap = true
  check('无关查询仍不误召回', !overlap)
}

console.log('\n[F1] host 明确下发生效库，客户端不必自行推断')
{
  const ws = makeWs('f1')
  const globalDir = join(root, 'home', 'self-improvement')
  mkdirSync(join(globalDir, 'self-improvement', 'memory'), { recursive: true })
  writeFileSync(join(globalDir, 'self-improvement', 'memory', 'lessons.md'), memLine('全局库的条目') + '\n', 'utf8')
  writeFileSync(join(ws, 'self-improvement', 'config.json'), JSON.stringify({ scope: 'global', globalDir }, null, 2) + '\n', 'utf8')
  const h = await harness(ws, 'f1-1')
  const st = await get(h.port, '/state?sessionId=' + h.agent.id)
  check('下发 effective 字段', !!st.effective, Object.keys(st.effective || {}).join(','))
  check('effectiveIsGlobal=true 与 effective.dir 指向全局库', st.effectiveIsGlobal === true && String(st.effective.dir).includes('self-improvement'), String(st.effective && st.effective.dir))
  check('effective 与 global 段同源（全球模式）', JSON.stringify(st.effective.sections) === JSON.stringify((st.global || {}).sections))
  h.server.close()
}

console.log('\n[F2] both（单向复用）不迁移提案到全局库')
{
  const ws = makeWs('both')
  const globalDir = join(root, 'home', 'self-improvement')
  mkdirSync(join(ws, 'self-improvement', 'proposals'), { recursive: true })
  mkdirSync(join(globalDir, 'self-improvement', 'memory'), { recursive: true })
  writeFileSync(join(ws, 'self-improvement', 'proposals', 'proposal-private.md'), '# 私有提案\n本工作区会话分析内容\n', 'utf8')
  const h = await harness(ws, 'both-1')
  const res = await post(h.port, '/config', { scope: 'both', globalDir, sessionId: h.agent.id })
  check('切换成功', res.ok === true, JSON.stringify(res).slice(0, 120))
  check('both 下未迁移提案（migrated=0）', (res.migrated || 0) === 0, String(res.migrated))
  let leaked = null
  try {
    leaked = readFileSync(join(globalDir, 'self-improvement', 'proposals', 'proposal-private.md'), 'utf8')
  } catch {
    leaked = null
  }
  check('全局库里没有本工作区提案（不外流）', leaked === null, leaked ? 'LEAKED' : 'clean')
  h.server.close()
}

console.log('\n[F3] 面板写入也受 fileCap 约束')
{
  const ws = makeWs('cap')
  // 必须真的超过 200000 才触发淘汰：每条约 660 字符 × 400 ≈ 264KB
  const big = Array.from({ length: 400 }, (_, i) => memLine('预置' + i + '：' + '填充'.repeat(300), 'origin:tool,imp:2'))
  writeFileSync(join(ws, 'self-improvement', 'memory', 'lessons.md'), big.join('\n') + '\n', 'utf8')
  const before = readFileSync(join(ws, 'self-improvement', 'memory', 'lessons.md'), 'utf8').length
  check('前置条件：预置文件确实超限', before > 200000, String(before))
  const h = await harness(ws, 'cap-1')
  const res = await post(h.port, '/memory', { action: 'add', section: 'LESSONS', text: '面板写入的一条', sessionId: h.agent.id })
  check('面板写入成功', res.ok === true, JSON.stringify(res).slice(0, 120))
  const after = readFileSync(join(ws, 'self-improvement', 'memory', 'lessons.md'), 'utf8')
  check('写入后体积被拉回 fileCap 以内（未被绕过）', after.length <= 200000, before + ' -> ' + after.length)
  check('淘汰后仍保留刚写入的条目', after.includes('面板写入的一条'))
  const status = JSON.parse(await h.tools.get('selfip_status').execute({}, { agent: h.agent }))
  check('淘汰计数已记录（面板路径也留痕）', (status.stores[0].evictedEntries || 0) > 0, String(status.stores[0].evictedEntries))
  h.server.close()
}

console.log('\n[F6] globalDir 不允许指向当前工作区')
{
  const ws = makeWs('selfref')
  const h = await harness(ws, 'selfref-1')
  const res = await post(h.port, '/config', { scope: 'global', globalDir: ws, sessionId: h.agent.id })
  check('面板拒绝自指 globalDir', res.ok === false, JSON.stringify(res).slice(0, 140))
  check('错误信息说明了原因', /不能指向当前工作区/.test(String(res.error || '')), String(res.error || ''))
  const toolRes = await h.tools.get('selfip_config').execute({ globalDir: ws }, { agent: h.agent })
  check('工具同样拒绝', toolRes.ok === false, JSON.stringify(toolRes).slice(0, 140))
  h.server.close()
}

console.log('\n[F8] CRLF 文件淘汰后不留 \\r 残渣')
{
  const ws = makeWs('crlf')
  const big = Array.from({ length: 400 }, (_, i) => memLine('低分' + i + '：' + '填充'.repeat(170), 'origin:tool,imp:1'))
  writeFileSync(join(ws, 'self-improvement', 'memory', 'lessons.md'), big.join('\r\n') + '\r\n', 'utf8')
  const h = await harness(ws, 'crlf-1')
  await h.tools.get('remember').execute({ kind: 'lesson', note: '触发淘汰', importance: 2 }, { agent: h.agent })
  await sleep(300)
  const after = readFileSync(join(ws, 'self-improvement', 'memory', 'lessons.md'), 'utf8')
  check('触发淘汰后体积回落', after.length <= 200000, String(after.length))
  const mixed = after.includes('\r\n') && /\n/.test(after.replace(/\r\n/g, ''))
  check('未出现 \\r\\n 与 \\n 混排', !mixed, mixed ? 'mixed' : 'consistent')
  h.server.close()
}

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败'))
rmSync(root, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
