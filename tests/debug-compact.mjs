/**
 * 调试：单独跑压缩链路，打印真实中间状态。
 *
 * 说明（诚实版）：
 * - 此文件原为调试脚本（不在测试清单里，`tests/*.mjs` 的通配不会当测试跑），
 *   在本轮工作中被误删且无备份，这里是**重建版**：用途与打印内容一致，
 *   内部桩按 DSH 契约重新实现，不保证与删除前逐字节相同。
 * - 已验证：脚本能加载插件、tool 注册可发现、`remember` 能正确解析本工作区
 *   并落盘（返回 ok:true）。但在这个**最小化**桩环境里，后台压缩链路
 *   （refreshMemory -> maybeCompact）没有触发，因此"压缩后长度"等字段只反映
 *   "未压缩"的状态——**不能用它判断压缩逻辑是否正确**。
 * - 压缩逻辑的正确性由 `tests/smoke.mjs` 与 `tests/memory-regression.mjs` 覆盖
 *   （它们有完整的 harness）。要在这里复现，需要补齐 harness 支持的服务。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// 与测试套件一致：源码在内存中加载，仅把 dsh-tools 的 defineTool 换成恒等实现
const sourcePath = join(here, '..', 'lib', 'index.js')
const source = readFileSync(sourcePath, 'utf8')
const patched = source.replace(
  "import { defineTool } from '@deepseek-ai/dsh-tools'",
  'const defineTool = (options) => options',
)
if (patched === source) {
  console.error('未能替换 defineTool 导入，调试前置条件变化')
  process.exit(1)
}
const plugin = await import('data:text/javascript;base64,' + Buffer.from(patched, 'utf8').toString('base64'))

// 后台链路是 fire-and-forget，异常会变成未处理的 rejection：调试脚本必须显式暴露
process.on('unhandledRejection', (error) => {
  console.log('  [unhandledRejection] ' + String((error && error.message) || error))
  if (error && error.stack) console.log(String(error.stack).split('\n').slice(0, 4).join('\n'))
})

const dir = mkdtempSync(join(tmpdir(), 'selfip-dbg-'))
const sub = join(dir, 'self-improvement')
mkdirSync(join(sub, 'memory'), { recursive: true })
mkdirSync(join(sub, 'logs'), { recursive: true })

const streamFrom = (text) =>
  (async function* () {
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()

const registered = new Map()
const commands = new Map()
/** 极简事件总线：插件靠 ctx.on 订阅 agent/session-start 来建立工作区 store */
const handlers = new Map()
const emit = (event, payload) => {
  for (const fn of handlers.get(event) || []) {
    try {
      fn(payload)
    } catch (error) {
      console.log('  [emit] ' + event + ' handler 抛错: ' + String((error && error.message) || error))
    }
  }
}

const ctx = {
  fs: {
    async resolve(p, opts) {
      const base = opts && opts.cwd ? opts.cwd : process.cwd()
      const full = /^([A-Za-z]:|[\\/])/.test(p) ? p : join(base, p)
      return { targetKey: full, displayPath: full }
    },
    async readText(target) {
      return readFileSync(target.targetKey, 'utf8')
    },
    async writeText(target, content) {
      mkdirSync(dirname(target.targetKey), { recursive: true })
      writeFileSync(target.targetKey, content, 'utf8')
    },
    async listDir(target) {
      return readdirSync(target.targetKey, { withFileTypes: true }).map((e) => ({
        name: e.name,
        isDirectory: () => e.isDirectory(),
      }))
    },
    async stat(target) {
      const st = statSync(target.targetKey)
      return { size: st.size, mtimeMs: st.mtimeMs }
    },
  },
  llm: { stream: streamFrom('') },
  systemPrompt: { section() {} },
  timer: { setTimeout: (fn, ms) => setTimeout(fn, ms), setInterval: (fn, ms) => setInterval(fn, ms) },
  sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: dir }) },
  tools: {
    register(definition) {
      if (definition && definition.name) registered.set(definition.name, definition)
      return () => {}
    },
  },
  effect: () => {},
  on(event, fn) {
    const list = handlers.get(event) || []
    list.push(fn)
    handlers.set(event, list)
    return () => {}
  },
  get: () => undefined,
  emit,
  // 面板依赖 webServer 服务；调试脚本里不给它，避免它反复重试刷屏
  webServer: undefined,
  command: {
    register(definition) {
      if (definition && definition.name) commands.set(definition.name, definition)
      return () => {}
    },
  },
  logger: { info() {}, warn() {}, error() {} },
}

plugin.apply(ctx)

const agent = { id: 'dbg', session: { header: { cwd: dir } } }

writeFileSync(join(sub, 'memory', 'facts.md'), '- 待去重条目 x\n'.repeat(700), 'utf8')
console.log('写入后 facts.md 长度 =', readFileSync(join(sub, 'memory', 'facts.md'), 'utf8').length, '（压缩阈值 4000）')

// 压缩桩：返回去重后的单条结果
ctx.llm.stream = streamFrom('- [2026-01-01T00:00:00.000Z] (fact) 压缩后的唯一条目')

const remember = registered.get('remember')
if (!remember) {
  console.log('未注册 remember 工具，注册表 =', [...registered.keys()].join(','))
} else {
  // 会话事件：让插件为该工作区建立 store/policy（否则工具拿不到 cwd）
  emit('agent/session-start', { agent, source: 'startup' })
  const result = await remember.execute({ kind: 'fact', note: '触发压缩的新条目' }, { agent })
  console.log('remember 返回 =', JSON.stringify(result))
}

// maybeCompact 是 fire-and-forget（调用处 `void maybeCompact(...)`），只能等它落盘
await new Promise((resolve) => setTimeout(resolve, 800))

const after = readFileSync(join(sub, 'memory', 'facts.md'), 'utf8')
console.log('压缩后 facts.md 长度 =', after.length)
console.log('包含压缩结果 =', after.includes('压缩后的唯一条目'))
console.log('memory 目录 =', readdirSync(join(sub, 'memory')).join(','))
const log = (rel) => {
  try {
    return readFileSync(join(sub, rel), 'utf8').trim()
  } catch {
    return '(无)'
  }
}
console.log('压缩留痕 =', log(join('logs', 'compact.md')))
console.log('拒绝留痕 =', log(join('logs', 'compact-rejected.md')))

// 面板/定时器会让事件循环一直活着，调试脚本显式收尾
process.exit(0)
