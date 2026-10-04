/** 复现 contract [6] 的间歇失败：循环直到失败，打印插件日志与关键中间状态。 */
import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const sourcePath = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const source = await readFile(sourcePath, 'utf8')
const patched = source.replace(
  "import { defineTool } from '@deepseek-ai/dsh-tools'",
  'const defineTool = (options) => options',
)
const plugin = await import('data:text/javascript;base64,' + Buffer.from(patched, 'utf8').toString('base64'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const logs = []

function makeCtx(dir) {
  const listeners = new Map()
  const tools = new Map()
  const roots = []
  const fsStub = {
    async resolve(path, opts) {
      const base = opts && opts.cwd ? opts.cwd : process.cwd()
      return { targetKey: /^([A-Za-z]:|[\\/])/.test(path) ? path : join(base, path), displayPath: path }
    },
    async readText(target) {
      try {
        const text = await readFile(target.targetKey, 'utf8')
        logs.push('READ-OK ' + target.targetKey.split('self-improvement')[1] + ' (' + text.length + ' chars)')
        return text
      } catch (error) {
        logs.push('READ-ERR ' + target.targetKey.split('self-improvement')[1] + ' ' + error.code)
        throw error
      }
    },
    async writeText(target, content) {
      const label = target.targetKey.split('self-improvement')[1]
      const text = String(content)
      logs.push('WRITE ' + label + ' (' + text.length + ') «' + text.slice(0, 24).replace(/\n/g, '⏎') + '»')
      await mkdir(dirname(target.targetKey), { recursive: true })
      await writeFile(target.targetKey, text, 'utf8')
      return { operation: 'update', version: 'v', before: null, after: text }
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
    llm: { stream: () => (async function* () {})() },
    systemPrompt: { section: () => () => {} },
    timer: { timeout: (cb, ms) => { const h = setTimeout(cb, Math.min(ms, 40)); return () => clearTimeout(h) } },
    sandboxPolicy: { workspaceRoot: '/', resolve: () => ({ mode: 'danger-full-access', workspaceRoot: dir, sessionId: 's' }) },
    tools: { register: (d) => { tools.set(d.name, d); return () => {} } },
    on: (e, f) => { const l = listeners.get(e) || []; l.push(f); listeners.set(e, l); return () => {} },
    get: (n) => (n === 'agents' ? { roots: () => roots } : n === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
  }
  return { ctx, roots, emit: (e, ...a) => { for (const f of listeners.get(e) || []) f(...a) } }
}

for (let run = 1; run <= 12; run++) {
  logs.length = 0
  const dir = mkdtempSync(join(tmpdir(), 'selfip-repro-'))
  await mkdir(join(dir, 'self-improvement', 'logs'), { recursive: true })
  await writeFile(join(dir, 'self-improvement', 'logs', 'session-done.md'), '# done\n> [[SELFIP-RETRO-DONE]] @ t\n', 'utf8')
  await writeFile(join(dir, 'self-improvement', 'logs', 'session-dead.md'), '# dead\n', 'utf8')
  await writeFile(join(dir, 'self-improvement', 'logs', 'partial-live.md'), '# live\n## Errors\n- still-open\n', 'utf8')
  await writeFile(
    join(dir, 'self-improvement', 'logs', 'pending.md'),
    [
      JSON.stringify({ t: '2026-01-01T00:00:00.000Z', file: 'logs/session-done.md', errors: 1, toolErrors: 0 }),
      JSON.stringify({ t: '2026-01-01T00:00:00.000Z', file: 'logs/session-dead.md', errors: 9, toolErrors: 9, attempts: 5 }),
    ].join('\n') + '\n',
    'utf8',
  )
  const h = makeCtx(dir)
  logs.push('--- APPLY ---')
  plugin.apply(h.ctx)
  const agent = { id: 'x' + run, session: { id: 'x' + run, header: { cwd: dir } } }
  h.roots.push(agent)
  logs.push('--- SESSION-START ---')
  h.emit('agent/session-start', { agent, source: 'startup' })
  await sleep(600)
  logs.push('--- CHECK ---')
  const pending = await readFile(join(dir, 'self-improvement', 'logs', 'pending.md'), 'utf8').catch(() => null)
  const dead = await readFile(join(dir, 'self-improvement', 'logs', 'pending-dead.md'), 'utf8').catch(() => null)
  const ok = pending !== null && !pending.includes('session-done.md') && !pending.includes('session-dead.md') && dead !== null
  console.log('run ' + run + ' -> ' + (ok ? 'ok' : 'FAIL') + ' | pending=' + JSON.stringify((pending || '').slice(0, 60)) + ' | dead=' + (dead ? 'yes' : 'no'))
  if (!ok) {
    console.log('  时间线（' + logs.length + ' 条）：')
    logs.forEach((line, index) => console.log('   ' + String(index).padStart(3, '0') + '  ' + line))
    break
  }
}
process.exit(0)
