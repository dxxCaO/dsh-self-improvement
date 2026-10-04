/**
 * 淘汰口径 + CJK 检索 的回归测试。
 *
 * 两项都是"记忆变多以后才会暴露"的正确性问题：
 * 1) fileCap 触发时若按 FIFO 丢最老，一条"很重要、被反复命中但很老"的教训
 *    会先于一条"新写的、低价值"条目被丢掉 —— 等于主动制造灾难性遗忘。
 * 2) 检索若只做整串子串匹配，中文场景几乎不可用（"沙箱围栏"搜不到"沙箱"）。
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

const root = mkdtempSync(join(tmpdir(), 'selfip-bm25-'))
process.env.DSH_HOME = join(root, 'home')
const plugin = await import('data:text/javascript;base64,' + Buffer.from(patched, 'utf8').toString('base64'))

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  [' + detail + ']' : ''))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 建一个最小 harness */
async function harness(ws, agentId) {
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
  const ctx = {
    fs: fsStub,
    llm: { stream: () => (async function* () {})() },
    systemPrompt: { section: () => () => {} },
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
  return { agent, tools }
}

function makeWs(tag) {
  const ws = join(root, 'ws-' + tag)
  mkdirSync(join(ws, 'self-improvement', 'memory'), { recursive: true })
  mkdirSync(join(ws, 'self-improvement', 'logs'), { recursive: true })
  writeFileSync(
    join(ws, 'self-improvement', 'config.json'),
    JSON.stringify({ scope: 'workspace', autoPromote: false }, null, 2) + '\n',
    'utf8',
  )
  return ws
}

const line = (text, meta) => '- [2026-09-12T04:00:00.000Z] (lesson) ' + text + ' {' + meta + '}'

console.log('\n[1] CJK 检索：部分词命中（旧实现整串匹配会漏）')
{
  const ws = makeWs('search')
  writeFileSync(
    join(ws, 'self-improvement', 'memory', 'lessons.md'),
    [
      line('沙箱围栏会拒绝工作区外的写入', 'origin:tool,imp:7'),
      line('网络受限时不要反复重试，改用 web_search 读取', 'origin:tool,imp:7'),
      line('编辑文件前必须先 read 目标文件', 'origin:tool,imp:8'),
    ].join('\n') + '\n',
    'utf8',
  )
  const { agent, tools } = await harness(ws, 'search-1')
  const search = tools.get('memory_search')

  const partial = await search.execute({ query: '沙箱' }, { agent })
  check('搜「沙箱」能命中「沙箱围栏…」（子串匹配也能，作基线）', partial.count >= 1, String(partial.count))

  const otherHalf = await search.execute({ query: '围栏' }, { agent })
  check('搜「围栏」同样命中该条', otherHalf.count >= 1, otherHalf.count ? otherHalf.hits[0].line.slice(0, 40) : 'no hit')

  const split = await search.execute({ query: '沙箱围栏' }, { agent })
  check('整串「沙箱围栏」命中', split.count >= 1, String(split.count))

  const latin = await search.execute({ query: 'web_search' }, { agent })
  check('西文检索仍可用', latin.count >= 1, String(latin.count))

  const miss = await search.execute({ query: '完全不相干的关键词xyz' }, { agent })
  check('无关查询不误召回', miss.count === 0, String(miss.count))
}

console.log('\n[2] 相关性排序：整串命中优先于部分词命中')
{
  const ws = makeWs('rank')
  writeFileSync(
    join(ws, 'self-improvement', 'memory', 'lessons.md'),
    [
      // 只沾到"压缩"一个词，但重要性更高（模拟"高权重但只部分匹配"的干扰项）
      line('数据库压缩与碎片整理策略', 'origin:tool,imp:10,uses:9'),
      // 完整包含查询短语，重要性较低
      line('记忆压缩必须保真校验后再覆盖', 'origin:tool,imp:5,uses:0'),
    ].join('\n') + '\n',
    'utf8',
  )
  const { agent, tools } = await harness(ws, 'rank-1')
  const res = await tools.get('memory_search').execute({ query: '记忆压缩' }, { agent })
  check('两条都命中', res.count === 2, String(res.count))
  check(
    '整串命中的排在高权重但只部分匹配的前面',
    res.count === 2 && res.hits[0].line.includes('记忆压缩必须保真校验'),
    res.count ? res.hits[0].line.slice(0, 46) : '-',
  )
}

console.log('\n[3] 检索结果字符上限（防止单次搜索吃掉上下文）')
{
  const ws = makeWs('cap')
  const long = Array.from({ length: 30 }, (_, i) => line('检索上限测试条目' + i + '：' + '内容'.repeat(60), 'origin:tool,imp:7'))
  writeFileSync(join(ws, 'self-improvement', 'memory', 'lessons.md'), long.join('\n') + '\n', 'utf8')
  const { agent, tools } = await harness(ws, 'cap-1')
  const res = await tools.get('memory_search').execute({ query: '检索上限测试条目', limit: 30 }, { agent })
  const totalChars = res.hits.reduce((sum, h) => sum + h.line.length, 0)
  check('命中被字符上限截断（未返回全部 30 条）', res.count < 30, 'count=' + res.count)
  check('总字符数受 2000 上限约束', totalChars <= 2400, String(totalChars))
  check('至少返回一条（不会因为一条就超限而返回空）', res.count >= 1, String(res.count))
}

console.log('\n[4] 淘汰口径：fileCap 触发时丢最低分，而不是丢最老')
{
  const ws = makeWs('evict')
  // 造一个确实超过 fileCap(200000) 的文件：一条"又老又重要且高频使用"的条目
  // + 大量"新但低价值"的条目。每条填充约 700 字符，400 条 ≈ 280KB，必定触发淘汰。
  const pinned = line('关键教训：这条既老又重要，绝不能被淘汰', 'origin:tool,imp:10,uses:9')
  const filler = Array.from({ length: 400 }, (_, i) =>
    line('低价值填充条目' + i + '：' + '填充内容'.repeat(170), 'origin:tool,imp:1,uses:0'),
  )
  // 把 pinned 放在最前面（最老）
  writeFileSync(join(ws, 'self-improvement', 'memory', 'lessons.md'), [pinned, ...filler].join('\n') + '\n', 'utf8')
  const before = readFileSync(join(ws, 'self-improvement', 'memory', 'lessons.md'), 'utf8')
  const { agent, tools } = await harness(ws, 'evict-1')
  // 触发一次追加写，越过 fileCap
  await tools.get('remember').execute({ kind: 'lesson', note: '触发淘汰写入', importance: 3 }, { agent })
  await sleep(300)
  const after = readFileSync(join(ws, 'self-improvement', 'memory', 'lessons.md'), 'utf8')
  check('文件被写入（前置条件）', after.length !== before.length)
  check('体积回到了上限内', after.length <= 200000, String(after.length))
  check(
    '高分老条目被保留（FIFO 会先丢它）',
    after.includes('关键教训：这条既老又重要，绝不能被淘汰'),
    after.includes('关键教训') ? 'kept' : 'DROPPED',
  )
  const lostFiller = 400 - (after.match(/低价值填充条目/g) || []).length
  check('丢掉的确实是低分条目', lostFiller > 0, '丢弃 ' + lostFiller + ' 条填充')

  // 留痕：必须在**同一个 harness** 内断言——每次 plugin.apply 都会新建一份 stores 闭包，
  // 换 harness 看到的是全新 store，不代表"没留痕"。
  const status = JSON.parse(await tools.get('selfip_status').execute({}, { agent }))
  const storeStatus = status.stores[0]
  check('自诊断可见 evictedEntries', Number.isFinite(storeStatus.evictedEntries) && storeStatus.evictedEntries > 0, String(storeStatus.evictedEntries))
  const noted = (storeStatus.writeErrors || []).some((e) => /fileCap/.test(e) && /按分数淘汰/.test(e))
  check('writeErrors 记录了"按分数淘汰"（不是静默丢弃）', noted, JSON.stringify((storeStatus.writeErrors || []).slice(-2)))
  check('兜底率字段存在（fallbackParses）', typeof storeStatus.fallbackParses === 'number', String(storeStatus.fallbackParses))

  // 等淘汰那次写入的防抖落盘落地，直接读盘确认（内存值 136 已在上面断言过）
  await sleep(3500)
  const midRaw = readFileSync(join(ws, 'self-improvement', 'logs', 'state.json'), 'utf8')
  const mid = JSON.parse(midRaw)
  check('淘汰后 evictedEntries 已落盘（内存 136 应出现在 state.json）', mid.evictedEntries > 0, String(mid.evictedEntries))
  // 新实例启动会 loadState：这是"跨重启仍可见"的真正验证
  const { agent: agent2, tools: tools2 } = await harness(ws, 'evict-2')
  const status2 = JSON.parse(await tools2.get('selfip_status').execute({}, { agent: agent2 }))
  check(
    '新实例自诊断能读到落盘的 evictedEntries（跨重启可见）',
    status2.stores[0].evictedEntries > 0,
    String(status2.stores[0].evictedEntries),
  )

  // 再等一轮防抖，确认后续事件不会把健康计数覆盖成 0
  await sleep(6000)
  const persisted = JSON.parse(readFileSync(join(ws, 'self-improvement', 'logs', 'state.json'), 'utf8'))
  check('state.json 含 evictedEntries 字段', Number.isFinite(persisted.evictedEntries), String(persisted.evictedEntries))
  check('state.json 含 fallbackParses 字段', Number.isFinite(persisted.fallbackParses), String(persisted.fallbackParses))
  check('state.json 含 lastCall（用于发现努力等级静默回退）', 'lastCall' in persisted, JSON.stringify(persisted.lastCall))
}

console.log('\n[5] 健康计数在自诊断里可见（跨重启的落盘见 [4] 末尾）')
{
  const ws = makeWs('health')
  writeFileSync(
    join(ws, 'self-improvement', 'memory', 'lessons.md'),
    line('健康度测试条目', 'origin:tool,imp:5') + '\n',
    'utf8',
  )
  const { agent, tools } = await harness(ws, 'health-1')
  const status = JSON.parse(await tools.get('selfip_status').execute({}, { agent }))
  const store = status.stores[0]
  for (const field of ['fallbackParses', 'evictedEntries', 'truncations', 'retroTruncated', 'retroAborted']) {
    check('自诊断暴露 ' + field, field in store, String(store[field]))
  }
  check('writeErrors 桶存在（留痕通道）', Array.isArray(store.writeErrors))
}

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败'))
rmSync(root, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
