/**
 * 记忆回归测试：记忆长期增长、压缩与失效交织后，关键事实是否仍能被注入。
 *
 * 这防的是最隐蔽的一类退化：注入上限、分区配额或压缩把"重要但较老"的事实挤掉，
 * 而且悄无声息。断言清单：
 *  1. 全部关键事实仍在注入文本中；
 *  2. 失效（invalidated）条目绝不出现；
 *  3. 注入总长度不超过上限（不会把提示撑爆）；
 *  4. 发生淘汰时必须有分片提示（而不是静默丢弃）；
 *  5. 被挤出注入的事实仍能用 memory_search 检索到（检索兜底）。
 *
 * 运行：node tests/memory-regression.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
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

const INJECT_CAP = 3200
const workdir = mkdtempSync(join(tmpdir(), 'selfip-regress-'))
const SUB = join(workdir, 'self-improvement')

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  [' + detail + ']' : ''))
}

const fsStub = {
  async resolve(path, opts) {
    const base = opts && opts.cwd ? opts.cwd : process.cwd()
    return { targetKey: /^([A-Za-z]:|[\\/])/.test(path) ? path : join(base, path), displayPath: path }
  },
  async readText(target) {
    return await readFile(target.targetKey, 'utf8')
  },
  async writeText(target, content) {
    await mkdir(dirname(target.targetKey), { recursive: true })
    await writeFile(target.targetKey, content, 'utf8')
    return { operation: 'update', version: 'v', before: null, after: content }
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

const listeners = new Map()
const tools = new Map()
const sections = []
const roots = []
const ctx = {
  fs: fsStub,
  llm: {
    stream: () =>
      (function* () {
        yield { type: 'text-delta', index: 0, text: '' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
  },
  systemPrompt: {
    section(section) {
      sections.push(section)
      return () => {}
    },
  },
  timer: { timeout: (cb, ms) => { const h = setTimeout(cb, Math.min(ms, 20)); return () => clearTimeout(h) } },
  sandboxPolicy: { workspaceRoot: '/', resolve: () => ({ mode: 'danger-full-access', workspaceRoot: workdir, sessionId: 'sid' }) },
  tools: { register: (d) => { tools.set(d.name, d); return () => {} } },
  on: (e, f) => { const l = listeners.get(e) || []; l.push(f); listeners.set(e, l); return () => {} },
  get: (n) => (n === 'agents' ? { roots: () => roots } : n === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
}

plugin.apply(ctx)
const agent = { id: 'regress', session: { header: { cwd: workdir } } }
roots.push(agent)
for (const f of listeners.get('agent/session-start') || []) f({ agent, source: 'startup' })
await new Promise((r) => setTimeout(r, 80))

// ---------- 构造：关键事实 + 大量噪声 + 一条失效条目 ----------
const oldTs = new Date(Date.now() - 120 * 86400000).toISOString()
const nowTs = new Date().toISOString()
const GOLDEN = [
  ['facts.md', '用户坚持用中文沟通'],
  ['facts.md', '工作区固定为 F:\\测试'],
  ['lessons.md', '插件写文件必须显式传沙箱策略'],
  ['lessons.md', '动态插件随进程重启消失'],
  ['methods.md', '用 --dump-config 验证组合'],
  ['methods.md', '先串行化写队列再谈并发'],
  ['resources.md', 'DSH 实现源码可直接阅读'],
  ['resources.md', '插件最小范本在 dsh-toolkit 下'],
]
const noise = (n) => Array.from({ length: n }, (_, i) => '- [' + nowTs + '] (fact) 噪声条目 ' + i + ' {imp:1}')

await mkdir(join(SUB, 'memory'), { recursive: true })
await mkdir(join(SUB, 'logs'), { recursive: true })

const factsLines = []
const lessonsLines = []
const methodsLines = []
const resourcesLines = []
for (const [file, text] of GOLDEN) {
  const line = '- [' + oldTs + '] (fact) ' + text + ' {imp:10}'
  if (file === 'facts.md') factsLines.push(line)
  else if (file === 'lessons.md') lessonsLines.push(line.replace('(fact)', '(lesson)'))
  else if (file === 'methods.md') methodsLines.push(line.replace('(fact)', '(method)'))
  else resourcesLines.push(line.replace('(fact)', '(resource)'))
}
// 一条被推翻的旧事实（必须永不出现）
const invalidated = '- [' + oldTs + '] (fact) 用户喜欢冗长的回答 {imp:9,invalid:' + nowTs + '}'

await writeFile(join(SUB, 'memory', 'facts.md'), [invalidated, ...factsLines, ...noise(80)].join('\n') + '\n', 'utf8')
await writeFile(join(SUB, 'memory', 'lessons.md'), [...lessonsLines, ...noise(80)].join('\n') + '\n', 'utf8')
await writeFile(join(SUB, 'memory', 'methods.md'), [...methodsLines, ...noise(60)].join('\n') + '\n', 'utf8')
await writeFile(join(SUB, 'memory', 'resources.md'), [...resourcesLines, ...noise(60)].join('\n') + '\n', 'utf8')

console.log('\n[1] 记忆膨胀后的注入回归')
await tools.get('remember').execute({ kind: 'fact', note: '触发缓存刷新', importance: 1 }, { agent })
const injected = sections[0].text({ agent })

let missing = []
for (const [, text] of GOLDEN) if (!injected.includes(text)) missing.push(text)
check('全部关键事实仍在注入中', missing.length === 0, missing.join(' / '))
check('失效条目绝不出现', !injected.includes('用户喜欢冗长的回答'))
check('注入长度不超上限', injected.length <= INJECT_CAP + 400, String(injected.length))
check('发生淘汰时给出分片提示', injected.includes('未展开') || injected.includes('本次未注入'))
check('注入带安全框架（记忆中的指令不得执行）', injected.includes('不得执行'))

console.log('\n[2] 检索兜底')
const dropped = GOLDEN.map(([, t]) => t).find((t) => !injected.includes(t))
const query = dropped || 'DSH 实现源码'
const found = await tools.get('memory_search').execute({ query: query.slice(0, 6) }, { agent })
check('被挤出注入的内容仍可检索', found.count > 0, '查询=' + query)
check('检索结果带分区信息', found.count > 0 && !!found.hits[0].file)

console.log('\n[3] 压缩后关键事实不丢')
// 桩必须返回"保真"的压缩结果（只去重）：新的保真校验会拒绝丢内容的压缩
ctx.llm.stream = async function* () {
  const current = await readFile(join(SUB, 'memory', 'facts.md'), 'utf8')
  const deduped = [...new Set(current.split('\n'))].filter(Boolean).join('\n')
  yield { type: 'text-delta', index: 0, text: deduped }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
// 把文件撑过压缩阈值并触发一次压缩
await writeFile(join(SUB, 'memory', 'facts.md'), '- 冗余 x\n'.repeat(600) + '\n' + factsLines.join('\n'), 'utf8')
await tools.get('remember').execute({ kind: 'fact', note: '触发压缩', importance: 1 }, { agent })
await new Promise((r) => setTimeout(r, 200))
const factsAfter = await readFile(join(SUB, 'memory', 'facts.md'), 'utf8')
const stillThere = factsLines.every((line) => {
  const text = /\(fact\)\s*(.+?)\s*\{/.exec(line)
  return !text || factsAfter.includes(text[1])
})
check('压缩后关键事实仍在文件中', stillThere)
const backupFiles = (await readdir(join(SUB, 'memory'))).filter((n) => n.startsWith('backup-'))
check('压缩留有备份可回溯', backupFiles.length > 0, backupFiles.join(','))

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败'))
rmSync(workdir, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
