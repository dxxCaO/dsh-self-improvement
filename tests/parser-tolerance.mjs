/**
 * 解析容错 + 真实输出夹具回归测试。
 *
 * 为什么需要它：插件靠"让模型输出 `## LESSONS` 这类段落"来落盘记忆，
 * 而**模型换代时最先变的就是输出格式**。解析器一旦认不出，就会走兜底路径
 * （把原文塞进 lessons.md），记忆质量悄悄下降却没有任何报错。
 *
 * 这里把"真实模型输出"存成夹具，任何格式变化都能在几分钟内被测试拦下：
 * 新模型接入时，抓一份它的真实输出丢进 fixtures/model-outputs/ 即可。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const libPath = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const fixturesDir = fileURLToPath(new URL('./fixtures/model-outputs', import.meta.url))

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  [' + detail + ']' : ''))
}

// ---- 从生产源码里摘出解析器（保证测的就是在跑的那份代码）----
const src = readFileSync(libPath, 'utf8')
const start = src.indexOf('  const SECTION_ALIASES')
const end = src.indexOf('  function extractCodeBlock')
if (start < 0 || end < 0) {
  console.error('无法从 lib/index.js 摘出解析器（SECTION_ALIASES / extractCodeBlock 标记缺失）')
  process.exit(1)
}
const parser = new Function(
  src.slice(start, end) + '\n; return { splitSections, normalizeSectionKey, SECTION_ALIASES }',
)()

console.log('\n[1] 标题层级与标记形态的容错')
{
  const cases = [
    ['## LESSONS\n- a', ['LESSONS'], '标准两级标题'],
    ['### LESSONS\n- a', ['LESSONS'], '三级标题'],
    ['# LESSONS\n- a', ['LESSONS'], '一级标题'],
    ['###### LESSONS\n- a', ['LESSONS'], '六级标题'],
    ['**LESSONS**\n- a', ['LESSONS'], '加粗独占一行'],
    ['LESSONS:\n- a', ['LESSONS'], '键 + 半角冒号'],
    ['LESSONS：\n- a', ['LESSONS'], '键 + 全角冒号'],
    ['## LESSONS \n- a', ['LESSONS'], '尾部空格'],
    ['## FACTSCLEAN\nx\n## HANDOFF\ny', ['FACTSCLEAN', 'HANDOFF'], '多段落'],
  ]
  for (const [input, expect, label] of cases) {
    const got = Object.keys(parser.splitSections(input))
    check(label, JSON.stringify(got) === JSON.stringify(expect), JSON.stringify(got) + ' 期望 ' + JSON.stringify(expect))
  }
}

console.log('\n[2] 中英文别名归一')
{
  const cases = [
    ['## 教训\n- a', 'LESSONS'],
    ['## 经验教训\n- a', 'LESSONS'],
    ['## 事实\n- a', 'FACTS'],
    ['## 方法\n- a', 'METHODS'],
    ['## 资料\n- a', 'RESOURCES'],
    ['## 交接\n- a', 'HANDOFF'],
    ['## 提案\n- a', 'PROPOSAL'],
    ['## 假设\n- a', 'HYPOTHESES'],
  ]
  for (const [input, expect] of cases) {
    const got = Object.keys(parser.splitSections(input))
    check(input.split('\n')[0] + ' -> ' + expect, got.length === 1 && got[0] === expect, JSON.stringify(got))
  }
  check('单数形式 LESSON -> LESSONS', parser.normalizeSectionKey('LESSON') === 'LESSONS')
  check('PLAYBOOK:slug 保留参数', parser.normalizeSectionKey('PLAYBOOK:my-slug') === 'PLAYBOOK:my-slug', String(parser.normalizeSectionKey('PLAYBOOK:my-slug')))
}

console.log('\n[3] 不误切：正文里的普通小标题不当作分段')
{
  const text = '## LESSONS\n- 这条讲的是 ### 某工具 的用法\n- 另一条'
  const got = Object.keys(parser.splitSections(text))
  check('只识别出 1 个段落', got.length === 1 && got[0] === 'LESSONS', JSON.stringify(got))
  const noHead = '这是一段没有段落标题的模型输出\n- 里面还有一行列表\n就这样'
  check('完全没有段落标题时返回空（交给兜底路径）', Object.keys(parser.splitSections(noHead)).length === 0)
  check('未知名标题不当作分段', Object.keys(parser.splitSections('## SOMETHING_ELSE\nx')).length === 0)
}

console.log('\n[4] 真实模型输出夹具')
if (!existsSync(fixturesDir)) {
  check('夹具目录存在', false, fixturesDir)
} else {
  const files = readdirSync(fixturesDir).filter((f) => f.endsWith('.txt'))
  check('夹具目录非空', files.length > 0, files.length + ' 个夹具')
  // 每个夹具首行是期望注释：`# expect: LESSONS,FACTS`（可选），其余为原始输出
  for (const name of files) {
    const raw = readFileSync(join(fixturesDir, name), 'utf8')
    const expectLine = /^#\s*expect:\s*(.*)$/m.exec(raw)
    const expect = expectLine ? expectLine[1].split(',').map((s) => s.trim()).filter(Boolean) : []
    // 只剥离单个 `#` 的注释行：`## LESSONS` 这类标题必须保留（`[^\n]*` 会连 `##` 一起吃掉）
    const body = raw.replace(/^#(?!#)[^\n]*\n/gm, '')
    const got = Object.keys(parser.splitSections(body))
    if (!expect.length) {
      check('夹具 ' + name + '（未声明期望，仅要求可解析）', got.length > 0, JSON.stringify(got))
    } else {
      const missing = expect.filter((e) => !got.includes(e))
      check('夹具 ' + name, missing.length === 0, missing.length ? '缺少 ' + missing.join(',') + '（实际 ' + JSON.stringify(got) + '）' : JSON.stringify(got))
    }
  }
}

console.log('\n[5] 单词级容错：normalizeSectionKey 的边界')
{
  check('空标题返回 null', parser.normalizeSectionKey('   ') === null)
  check('纯符号返回 null', parser.normalizeSectionKey('***') === null)
  check('带反引号也能归一', parser.normalizeSectionKey('`LESSONS`') === 'LESSONS', String(parser.normalizeSectionKey('`LESSONS`')))
  check('大小写不敏感', parser.normalizeSectionKey('lessons') === 'LESSONS')
}

console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败'))
process.exit(failures === 0 ? 0 : 1)
