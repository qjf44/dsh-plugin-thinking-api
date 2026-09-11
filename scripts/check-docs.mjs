// dsh-plugin-thinking-api · 文档与版本同步自检
//
// 用途：拦住「代码发了、文档没发」的漂移。2026-09-11 实际踩过：
//   0.1.4 / 0.1.5 发布时改动仍留在 CHANGELOG 的 [Unreleased]，README 的 DSH 徽章
//   和「Supported DSH」也停在 0.1.0-rc.6 —— CI 当时只查语法和包结构，没拦住，
//   而 npm 包页面展示的 README 就是包内那份，用户直接看到旧文档。
//
// 用法：
//   node scripts/check-docs.mjs
//
// 纯只读，不联网，不装依赖。

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')

const read = (rel) => readFileSync(join(pkgRoot, rel), 'utf8')

let failed = 0
const fail = (msg) => { failed += 1; console.error(`[check-docs] ✗ ${msg}`) }
const ok = (msg) => console.log(`[check-docs] ✓ ${msg}`)

const pkg = JSON.parse(read('package.json'))
const version = pkg.version

// ---- 1. CHANGELOG 必须有当前版本的段落，且不能还留在 [Unreleased] ----
const changelog = read('CHANGELOG.md')
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const hasSection = new RegExp(`^## \\[${esc(version)}\\]`, 'm').test(changelog)
if (hasSection) {
  ok(`CHANGELOG.md 含 ## [${version}] 段落`)
} else {
  fail(`CHANGELOG.md 缺少 ## [${version}] 段落 —— 把 [Unreleased] 内的改动归入该版本段后再发布。`)
}

// 版本段与 package.json 的版本应一致（最新版本段 == 当前版本）
const sections = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1])
const released = sections.filter((s) => s.toLowerCase() !== 'unreleased')
if (released.length === 0) {
  fail('CHANGELOG.md 里找不到任何已发布版本段。')
} else if (released[0] !== version) {
  fail(`CHANGELOG.md 最新版本段是 [${released[0]}]，但 package.json 是 ${version} —— 两者必须一致。`)
} else {
  ok(`CHANGELOG.md 最新版本段与 package.json 一致（[${version}]）`)
}

// ---- 2. 两个 README 的 DSH 徽章必须体现「最高支持的 DSH 版本」 ----
//
// 最高支持版本 = peerDependencies 里所有 >= 下界中的最大者。
// 注意不能取字符串抓到的最大版本：范围里还有「不含的上界」（如 <0.1.6）。
const range = pkg.peerDependencies?.['@deepseek-ai/dsh-llm-pi-ai'] ?? ''
const lowers = [...range.matchAll(/>=\s*(\d+\.\d+\.\d+(?:-rc\.\d+)?)/g)].map((m) => m[1])
if (lowers.length === 0) {
  fail(`无法从 peerDependencies 解析 DSH 版本范围：${range || '(缺失)'}`)
} else {
  const key = (v) => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/)
    return [+m[1], +m[2], +m[3], m[4] === undefined ? Infinity : +m[4]]
  }
  const maxSupported = [...lowers].sort((a, b) => {
    const ka = key(a), kb = key(b)
    for (let i = 0; i < 4; i += 1) if (ka[i] !== kb[i]) return ka[i] - kb[i]
    return 0
  }).pop()
  ok(`peer 范围最高支持 DSH ${maxSupported}（下界：${[...new Set(lowers)].join(', ')}）`)

  // badgen 编码：`--` 代表字面量点，URL 编码（%20/%E2%80%93）需解码。
  // 先解码，再把 `--` 还原为 `.`，才能与真实版本号比对。
  const decode = (s) => {
    let t = s
    try { t = decodeURIComponent(t) } catch { /* 保留原串 */ }
    return t.replace(/--/g, '.')
  }
  for (const file of ['README.md', 'README.zh-CN.md']) {
    const src = read(file)
    const m = src.match(/badgen\.net\/badge\/dsh\/([^"'\s)]+)/)
    if (m === null) {
      fail(`${file} 找不到 DSH 徽章（badgen.net/badge/dsh/...）`)
      continue
    }
    const badgeText = decode(m[1])
    if (badgeText.includes(maxSupported)) {
      ok(`${file} DSH 徽章已体现最高支持版本（${badgeText}）`)
    } else {
      fail(`${file} DSH 徽章已过期：期望包含 ${maxSupported}，实际「${badgeText}」`)
    }
  }
}

console.log('')
if (failed > 0) {
  console.error(`[check-docs] 结果：${failed} 项文档不同步 —— 详见 PUBLISH-CHECKLIST 第 3 节。`)
  process.exit(1)
}
console.log('[check-docs] 结果：文档与版本同步，通过。')
