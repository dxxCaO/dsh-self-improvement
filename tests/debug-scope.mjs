/**
 * 手工诊断：经验复用范围（scope）与全局库的读写路径。
 *
 * 契约测试已覆盖这些断言（tests/contract.mjs [7]），本脚本用于在真实文件系统上
 * 快速确认"配置改到哪、文件写到哪、注入读到什么"——排查问题时比读测试输出直观。
 *
 * 运行：node tests/debug-scope.mjs
 */
import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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

const workdir = mkdtempSync(join(tmpdir(), 'selfip-scope-'))
const SUB = join(workdir, 'self-improvement')
await mkdir(join(SUB, 'memory'), { recursive: true })
await mkdir(join(SUB, 'logs'), { recursive: true })

const fsStub = {
  async resolve(path, opts) {
    const base = opts && opts.cwd ? opts.cwd : process.cwd()
    const full = /^([A-Za-z]:[\\/]|[\\/])/.test(path) ? path : join(base, path)
    return { targetKey: full, displayPath: path }
  },
  async readText(target) {
    return await readFile(target.targetKey, 'utf8')
  },
  async writeText(target, content) {
    await mkdir(join(target.targetKey, '..'), { recursive: true })
    await writeFile(target.targetKey, content, 'utf8')
    return { operation: 'update' }
  },
  async listDir(target) {
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(target.targetKey, { withFileTypes: true })
    return entries.map((e) => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' : 'file',
      target: { targetKey: join(target.targetKey, e.name), displayPath: e.name },
    }))
  },
}

const sections = []
const tools = new Map()
const ctx = {
  fs: fsStub,
  llm: { stream: async function* () { yield { type: 'text-delta', text: '' } } },
  systemPrompt: { section: (s) => sections.push(s) },
  timer: { timeout: (fn, ms) => setTimeout(fn, ms), interval: () => {}, cancel: () => {} },
  sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: workdir }), workspaceRoot: workdir },
  tools: { register: (tool) => tools.set(tool.name, tool) },
  get: () => undefined,
  effect: () => () => {},
  on: () => () => {},
}

plugin.apply(ctx)
const agent = { id: 'diag-1', session: { header: { cwd: workdir } } }

console.log('工作区 =', workdir)
console.log('DSH_HOME =', process.env.DSH_HOME)

// 1) 默认范围：经验只写本工作区
const res = await tools.get('remember').execute({ kind: 'fact', note: '默认范围下的本地条目', importance: 5 }, { agent })
console.log('\n[1] 默认配置 remember ->', JSON.stringify(res))
console.log('    注入长度 =', sections[0].text({ agent }).length)

// 2) 切到 global：记忆改写到全局库，所有工作区共用
const globalDir = join(workdir, 'global-lib')
await writeFile(join(SUB, 'config.json'), JSON.stringify({ scope: 'global', globalDir }) + '\n', 'utf8')
await new Promise((r) => setTimeout(r, 1600)) // 越过配置变更检查的节流窗口
const cfg = await tools.get('selfip_config').execute({}, { agent })
console.log('\n[2] selfip_config ->', cfg.scope, '| globalDir =', cfg.globalDir)
const res2 = await tools.get('remember').execute({ kind: 'method', note: '全局共享的通用方法', importance: 8 }, { agent })
console.log('    remember(global) ->', JSON.stringify(res2))
const globalText = await readFile(join(globalDir, 'self-improvement', 'memory', 'methods.md'), 'utf8').catch(() => null)
console.log('    全局库内容 ->', JSON.stringify(globalText))
console.log('    注入长度 =', sections[0].text({ agent }).length)

// 3) 检索与自诊断
const found = await tools.get('memory_search').execute({ query: '全局共享' }, { agent })
console.log('\n[3] memory_search ->', JSON.stringify(found))
const status = JSON.parse(await tools.get('selfip_status').execute({}, { agent }))
console.log('    globalLibraries ->', JSON.stringify(status.globalLibraries))
console.log('    scope =', status.stores[0].config.scope, '| readErrors =', JSON.stringify(status.stores[0].readErrors))
