/**
 * 经验范围切换的"可见性告知"测试（单进程单实例，避免共享模块级 ctx）。
 *
 * 背景：切换 scope 只改读取范围，**不搬数据**——`memory/` 原地不动，只有 `proposals/`
 * 会迁移。于是 workspace→global 会让本工作区已沉淀的记忆一次性从注入与检索里消失，
 * 且 global 模式不做提升、永远没有回填机会。数据没丢，但用户无从得知。
 *
 * 这里锁定修复后的行为：切换前把"会隐藏哪一层、多少条、怎么恢复"算出来回显。
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

const root = mkdtempSync(join(tmpdir(), 'selfip-scope-'))
// 插件按 ${DSH_HOME} 解析全局库位置，隔离到一次性目录，绝不碰真实全局库
process.env.DSH_HOME = join(root, 'home')

const plugin = await import('data:text/javascript;base64,' + Buffer.from(patched, 'utf8').toString('base64'))

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  [' + detail + ']' : ''))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const memoryLine = (i, text) =>
  '- [2026-09-11T10:00:00.000Z] (lesson) ' + text + ' {origin:tool,imp:8,uses:' + (i % 3) + '}\n'

/** 建一个工作区库 + 全局库，各放若干条真实格式的记忆 */
function seedDirs(wsCount, globalCount) {
  const ws = join(root, 'ws-' + Math.random().toString(36).slice(2, 9))
  const globalDir = join(root, 'global-' + Math.random().toString(36).slice(2, 9))
  mkdirSync(join(ws, 'self-improvement', 'memory'), { recursive: true })
  mkdirSync(join(ws, 'self-improvement', 'logs'), { recursive: true })
  mkdirSync(join(globalDir, 'self-improvement', 'memory'), { recursive: true })
  if (wsCount) {
    writeFileSync(
      join(ws, 'self-improvement', 'memory', 'lessons.md'),
      Array.from({ length: wsCount }, (_, i) => memoryLine(i, '本工作区教训第' + i + '条')).join(''),
      'utf8',
    )
  }
  if (globalCount) {
    writeFileSync(
      join(globalDir, 'self-improvement', 'memory', 'methods.md'),
      Array.from({ length: globalCount }, (_, i) => memoryLine(i, '全局方法第' + i + '条')).join(''),
      'utf8',
    )
  }
  return { ws, globalDir }
}

/** 把工作区配置写成指定 scope（工具会据此判断"旧范围") */
function writeWorkspaceConfig(ws, scope, globalDir) {
  writeFileSync(
    join(ws, 'self-improvement', 'config.json'),
    JSON.stringify({ scope, globalDir, autoPromote: true }, null, 2) + '\n',
    'utf8',
  )
}

/** 建一个最小 harness，返回 selfip_config 工具 */
async function harness(ws, globalDir) {
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
    async listDir() {
      return []
    },
  }
  const ctx = {
    fs: fsStub,
    llm: { stream: () => (async function* () {})() },
    systemPrompt: { section: () => () => {} },
    timer: { timeout: (cb, ms) => { const h = setTimeout(cb, Math.min(ms, 30)); return () => clearTimeout(h) } },
    sandboxPolicy: { workspaceRoot: '/', resolve: () => ({ mode: 'danger-full-access', workspaceRoot: ws, sessionId: 's' }) },
    tools: { register: (d) => { tools.set(d.name, d); return () => {} } },
    on: (e, f) => { const l = listeners.get(e) || []; l.push(f); listeners.set(e, l); return () => {} },
    get(name) {
      if (name === 'agents') return { roots: () => roots }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return undefined
    },
  }
  const agent = { id: 'scope-1', session: { id: 'scope-1', header: { cwd: ws } } }
  roots.push(agent)
  plugin.apply(ctx)
  await sleep(30)
  return { tool: tools.get('selfip_config'), agent }
}

console.log('\n[1] 切到 global：本工作区记忆会被隐藏，必须明确告知')
{
  const { ws, globalDir } = seedDirs(7, 0)
  writeWorkspaceConfig(ws, 'workspace', globalDir)
  const h = await harness(ws, globalDir)
  const out = await h.tool.execute({ scope: 'global' }, { agent: h.agent })
  const text = String(out.text || '')
  check('切换成功', out.ok === true, String(out.ok))
  check('提示里给出被隐藏的条数', /7\s*条/.test(text), text.split('\n').filter((l) => l.includes('注意')).join(' / ') || '(无注意行)')
  check('提示里给出恢复办法', /切回\s*workspace/.test(text), '(恢复说明)')
  check('提示里说明文件仍在原处', /self-improvement\/memory/.test(text), '(路径说明)')
  check('额外提醒新库为空', /目前没有条目/.test(text), '(空库提醒)')
}

console.log('\n[2] 切到 both：两层都能读，不该有隐藏提示')
{
  const { ws, globalDir } = seedDirs(5, 3)
  writeWorkspaceConfig(ws, 'workspace', globalDir)
  const h = await harness(ws, globalDir)
  const out = await h.tool.execute({ scope: 'both' }, { agent: h.agent })
  const text = String(out.text || '')
  check('切换成功', out.ok === true, String(out.ok))
  check('没有"会消失"的提示', !/会立刻从注入与检索中消失/.test(text), '(无隐藏提示)')
}

console.log('\n[3] 从 both 切到 workspace：全局库那层会被隐藏')
{
  const { ws, globalDir } = seedDirs(4, 6)
  writeWorkspaceConfig(ws, 'both', globalDir)
  const h = await harness(ws, globalDir)
  const out = await h.tool.execute({ scope: 'workspace' }, { agent: h.agent })
  const text = String(out.text || '')
  check('切换成功', out.ok === true, String(out.ok))
  check('告知全局库被隐藏且给出条数', /6\s*条/.test(text) && /全局库/.test(text), text.split('\n').filter((l) => l.includes('注意')).join(' / ') || '(无注意行)')
  check('提示切回 both/global 可恢复', /切回\s*both\s*或\s*global/.test(text), '(恢复说明)')
}

console.log('\n[4] 范围未变化时不打扰用户')
{
  const { ws, globalDir } = seedDirs(5, 5)
  writeWorkspaceConfig(ws, 'workspace', globalDir)
  const h = await harness(ws, globalDir)
  const out = await h.tool.execute({ scope: 'workspace' }, { agent: h.agent })
  const text = String(out.text || '')
  check('同范围写入不产生隐藏提示', !/会立刻从注入与检索中消失/.test(text) && !/目前没有条目/.test(text), '(安静)')
}

console.log('\n[5] 只改 autoPromote（不动 scope）不产生提示')
{
  const { ws, globalDir } = seedDirs(5, 5)
  writeWorkspaceConfig(ws, 'both', globalDir)
  const h = await harness(ws, globalDir)
  const out = await h.tool.execute({ autoPromote: false }, { agent: h.agent })
  const text = String(out.text || '')
  check('未改范围时不提示隐藏', !/会立刻从注入与检索中消失/.test(text), '(安静)')
}

console.log('\n[6] 提示只报告、不改数据（记忆文件原地不动）')
{
  const { ws, globalDir } = seedDirs(7, 0)
  writeWorkspaceConfig(ws, 'workspace', globalDir)
  const h = await harness(ws, globalDir)
  const before = readFileSync(join(ws, 'self-improvement', 'memory', 'lessons.md'), 'utf8')
  await h.tool.execute({ scope: 'global' }, { agent: h.agent })
  const after = readFileSync(join(ws, 'self-improvement', 'memory', 'lessons.md'), 'utf8')
  check('本工作区记忆文件内容未被改动', before === after, before === after ? 'identical' : 'CHANGED')
}

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败'))
rmSync(root, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
