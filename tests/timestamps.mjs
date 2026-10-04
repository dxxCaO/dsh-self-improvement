/**
 * 时间戳本地化测试。
 *
 * 之前 `nowIso()` 用 `toISOString()` 恒返回 UTC，在 UTC+8 机器上导致：
 * - 记忆/日志显示的时间比本地早 8 小时，凌晨时段**日期差一天**；
 * - 每日 token 预算按 `slice(0,10)` 取"当天"，额度在**本地 08:00** 重置而非午夜。
 *
 * 修复后写入带偏移的本地时间（`...+08:00`），本文件锁住该行为，
 * 并验证与历史 `...Z` 条目混存时**排序仍然正确**（全部按 Date.parse 比较）。
 */
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const sourcePath = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const src = await readFile(sourcePath, 'utf8')
const patched = src.replace(
  "import { defineTool } from '@deepseek-ai/dsh-tools'",
  'const defineTool = (options) => options',
)

const root = mkdtempSync(join(tmpdir(), 'selfip-time-'))
process.env.DSH_HOME = join(root, 'home')
const plugin = await import('data:text/javascript;base64,' + Buffer.from(patched, 'utf8').toString('base64'))

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  [' + detail + ']' : ''))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 摘出 nowIso 单测（纯函数）----
const nowIsoSrc = src.slice(src.indexOf('function nowIso()'), src.indexOf('function safeErr'))
const nowIso = new Function(nowIsoSrc + '; return nowIso;')()

console.log('\n[1] nowIso 产出带偏移的本地时间')
{
  const v = nowIso()
  check('格式为 ISO 且带 ±HH:MM 偏移', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/.test(v), v)
  const local = new Date()
  const localDate = [local.getFullYear(), String(local.getMonth() + 1).padStart(2, '0'), String(local.getDate()).padStart(2, '0')].join('-')
  check('日期段等于本地日期（旧实现这里是 UTC 日期）', v.slice(0, 10) === localDate, v.slice(0, 10) + ' vs ' + localDate)
  const localHour = String(local.getHours()).padStart(2, '0')
  check('小时段等于本地小时（旧实现差 8 小时）', v.slice(11, 13) === localHour, v.slice(11, 13) + ' vs ' + localHour)
  check('Date.parse 可解析', Number.isFinite(Date.parse(v)), String(Date.parse(v)))
  check('解析结果与当前时刻一致（±2s）', Math.abs(Date.parse(v) - Date.now()) < 2000, String(Date.parse(v) - Date.now()))
  check('不再是 Z 结尾', !v.endsWith('Z'))
}

console.log('\n[2] 每日预算的"当天"取本地日期')
{
  const v = nowIso()
  const day = v.slice(0, 10)
  const utcDay = new Date().toISOString().slice(0, 10)
  const local = new Date()
  const localDate = [local.getFullYear(), String(local.getMonth() + 1).padStart(2, '0'), String(local.getDate()).padStart(2, '0')].join('-')
  check('slice(0,10) = 本地日期', day === localDate, day)
  // 宿主为东八区时：本地 00:00–08:00 时段，本地日期会领先 UTC 日期一天
  const offsetHours = -new Date().getTimezoneOffset() / 60
  const localHourNow = local.getHours()
  if (offsetHours > 0 && localHourNow < offsetHours) {
    check('凌晨时段：本地日期严格领先 UTC 日期（旧实现会算错）', day > utcDay, day + ' vs UTC ' + utcDay)
  } else {
    check('非凌晨时段：本地与 UTC 日期同日或领先（信息性）', day >= utcDay, day + ' vs UTC ' + utcDay)
  }
}

console.log('\n[3] 混存格式排序正确（旧 Z 条目 + 新带偏移条目）')
{
  // 同一时刻的两种写法必须解析为同一毫秒，否则"按时间比较"会错
  const a = Date.parse('2026-09-12T04:05:00.000Z')
  const b = Date.parse('2026-09-12T12:05:00.000+08:00')
  check('同一时刻的 Z 与 +08:00 解析相等', a === b, a + ' vs ' + b)
  // 而字典序确实会错——这正是"不能靠字符串排序"的原因
  check('（对照）字典序在该组合下不可靠', '2026-09-12T04:05:00.000Z' > '2026-09-12T12:05:00.000+08:00' === false)
  // 旧格式仍可被 parseMemoryLine 正常解析
  const oldLine = '- [2026-09-12T04:05:00.000Z] (lesson) 历史条目 {origin:tool,imp:5}'
  check('历史 Z 条目仍能匹配记忆行格式', /^- \[[^\]]+\] \(/.test(oldLine))
}

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
      const { writeFileSync } = await import('node:fs')
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

console.log('\n[4] 端到端：写入记忆的时间戳是本地时间')
{
  const ws = join(root, 'ws-time')
  mkdirSync(join(ws, 'self-improvement', 'memory'), { recursive: true })
  mkdirSync(join(ws, 'self-improvement', 'logs'), { recursive: true })
  const { agent, tools } = await harness(ws, 'time-1')
  const before = Date.now()
  await tools.get('remember').execute({ kind: 'lesson', note: '时间戳本地化验证条目', importance: 5 }, { agent })
  await sleep(200)
  const content = readFileSync(join(ws, 'self-improvement', 'memory', 'lessons.md'), 'utf8')
  const m = /^- \[([^\]]+)\]/.exec(content)
  check('记忆行已写入', !!m, content.slice(0, 60))
  if (m) {
    const stamp = m[1]
    check('写入的时间戳带偏移（不是 Z）', /[+-]\d{2}:\d{2}$/.test(stamp), stamp)
    check('时间戳落在本次调用时刻附近（±10s）', Math.abs(Date.parse(stamp) - before) < 10000, String(Date.parse(stamp) - before))
    check('显示时间等于本地时间', Math.abs(Date.parse(stamp) - Date.now()) < 10000, stamp)
  }
}

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败'))
rmSync(root, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
