// dsh-plugin-thinking-api · 升级后兼容性自检
//
// 用途：每次升级 DSH / pi-ai 后跑一遍，确认插件依赖的契约没被新版本破坏。
// 失败时会点名是哪个契约变了，以及对应的修复位置；成功则输出各依赖版本。
//
// 用法：
//   node scripts/check-compat.mjs [--workspace <路径>]
//
// 说明：
//   - 默认在「本插件的 package.json 所在目录」向上找 workspace node_modules
//     （即 DSH 运行时安装处）；也可用 --workspace 显式指定。
//   - 纯只读：不改插件目录、不写 settings、不发网络请求（仅建一个用完即删的临时目录）。
//   - 插件是 ESM，且依赖裸导入 workspace 里的 @deepseek-ai/*；脚本把插件 lib/
//     复制进临时目录并软链 workspace node_modules，从而用真实依赖解析并执行它。

import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')

// pnpm 布局下 @deepseek-ai/* 不提升到顶层 node_modules，而是落在
// <root>/node_modules/.pnpm/<name>@<version>_<hash>/node_modules/<name>。
//
// 旧实现取「dsh-llm-pi-ai 那个 .pnpm 条目内部的 node_modules」当解析根，隐含假设
// pi-ai 的依赖闭包里带着 dsh-settings。该假设在 DSH 0.1.7 失效：0.1.7 的
// dsh-llm-pi-ai 依赖里新增 cordis-plugin-loader、去掉了 dsh-settings，
// 于是本脚本会报 ERR_MODULE_NOT_FOUND 指向 dsh-settings —— 这是**脚本定位问题，
// 不是插件不兼容**（0.1.6 恰好因为 pi-ai 带着 dsh-settings 才碰巧能跑）。
//
// 改为合成一个扁平解析根：扫描 .pnpm 下所有 <scope>/<name>，每个包名取版本最高
// 的一个软链到临时目录。这样不依赖任何单个包的依赖闭包，对两代布局都成立。
const flatRootCache = new Map()
function pnpmNodeModules(root) {
  const store = join(root, 'node_modules', '.pnpm')
  if (!existsSync(store)) return null
  if (flatRootCache.has(store)) return flatRootCache.get(store)

  let entries
  try {
    entries = readdirSync(store)
  } catch {
    return null
  }

  // 收集 <scope>/<name> → 最高版本的实体目录
  const best = new Map()
  for (const dir of entries) {
    if (dir.startsWith('.')) continue
    const inner = join(store, dir, 'node_modules')
    if (!existsSync(inner)) continue
    for (const scopeOrName of readdirSync(inner)) {
      const scopePath = join(inner, scopeOrName)
      // 既支持 @scope/name，也支持无 scope 的裸包
      const names = scopeOrName.startsWith('@')
        ? readdirSync(scopePath).map((n) => [`${scopeOrName}/${n}`, join(scopePath, n)])
        : [[scopeOrName, scopePath]]
      for (const [pkgName, pkgPath] of names) {
        if (!existsSync(join(pkgPath, 'package.json'))) continue
        // 用 pnpm 目录名里的版本排序，保证「最高版本胜出」
        const previous = best.get(pkgName)
        if (previous === undefined || dir > previous.sortKey) best.set(pkgName, { pkgPath, sortKey: dir })
      }
    }
  }
  if (best.size === 0) {
    flatRootCache.set(store, null)
    return null
  }

  const flat = mkdtempSync(join(tmpdir(), 'thinking-api-flat-'))
  for (const [pkgName, { pkgPath }] of best) {
    const target = join(flat, pkgName)
    mkdirSync(dirname(target), { recursive: true })
    try {
      symlinkSync(pkgPath, target, 'dir')
    } catch {
      /* 同名冲突时保留先到的（版本排序已保证择优） */
    }
  }
  flatRootCache.set(store, flat)
  return flat
}

function findWorkspaceNodeModules(start) {
  let dir = start
  for (;;) {
    const candidate = join(dir, 'node_modules')
    // 1) 顶层提升布局
    if (existsSync(join(candidate, '@deepseek-ai', 'dsh-llm-pi-ai'))) return candidate
    // 2) pnpm 布局：用 .pnpm 实体的 node_modules 作为解析根
    const pnpm = pnpmNodeModules(dir)
    if (pnpm !== null) return pnpm
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const args = process.argv.slice(2)
const wsFlag = args.indexOf('--workspace')
const explicit = wsFlag !== -1 ? resolve(args[wsFlag + 1]) : null
// 显式传参时先按「根目录」找顶层 node_modules，找不到再尝试该根的 pnpm 布局
let nodeModules = null
if (explicit !== null) {
  const direct = join(explicit, 'node_modules')
  if (existsSync(join(direct, '@deepseek-ai', 'dsh-llm-pi-ai'))) nodeModules = direct
  else nodeModules = pnpmNodeModules(explicit) ?? (existsSync(direct) ? direct : null)
} else {
  nodeModules = findWorkspaceNodeModules(pkgRoot)
}

if (nodeModules === null || !existsSync(nodeModules)) {
  console.error('[check-compat] 找不到 DSH 运行时 node_modules（含 @deepseek-ai/dsh-llm-pi-ai）。')
  console.error('[check-compat] 请用 --workspace 指定 DSH 运行时根目录，例如：')
  console.error('[check-compat]   node scripts/check-compat.mjs --workspace ~/.dsh/runtime/dsh-app')
  console.error('[check-compat] 或（profile 布局）：--workspace ~/.dsh/profiles/<profile>')
  console.error('[check-compat] 支持 npm 顶层提升布局与 pnpm（node_modules/.pnpm）布局。')
  process.exit(2)
}

// 依赖缺失时不再抛栈：统一走 fail() 并给出可读结论。
const probePackage = (name, subpath = 'package.json') => {
  const p = join(nodeModules, name, subpath)
  return existsSync(p) ? p : null
}

const readVersion = (name) => {
  try {
    return JSON.parse(readFileSync(join(nodeModules, name, 'package.json'), 'utf8')).version
  } catch {
    return '?'
  }
}

let failed = 0
const fail = (msg) => { failed += 1; console.error(`[check-compat] ✗ ${msg}`) }
const ok = (msg) => console.log(`[check-compat] ✓ ${msg}`)

console.log('[check-compat] workspace node_modules:', nodeModules)
console.log('[check-compat] 依赖版本:')
console.log('  - @deepseek-ai/dsh-llm-pi-ai :', readVersion('@deepseek-ai/dsh-llm-pi-ai'))
console.log('  - @deepseek-ai/dsh-llm       :', readVersion('@deepseek-ai/dsh-llm'))
console.log('  - @earendil-works/pi-ai      :', readVersion('@earendil-works/pi-ai'))
console.log('  - @deepseek-ai/cordis        :', readVersion('@deepseek-ai/cordis'))
console.log('')

// ---- 准备：临时目录，把插件 lib 复制进去 + 软链 workspace node_modules，使裸导入可解析 ----
const tmp = mkdtempSync(join(tmpdir(), 'thinking-api-check-'))
let mod = null
try {
  cpSync(join(pkgRoot, 'lib'), join(tmp, 'lib'), { recursive: true })
  symlinkSync(nodeModules, join(tmp, 'node_modules'), 'dir')
  mod = await import(join(tmp, 'lib', 'index.mjs'))
} catch (error) {
  fail(`lib/index.mjs 无法在真实依赖下 import（某个依赖符号被移除/改名?）: ${error.message}`)
}

// ---- 契约 1：插件模块结构 ----
if (mod !== null) {
  if (typeof mod.apply === 'function' && typeof mod.inject === 'object') ok('lib/index.mjs 导出 apply/inject 正常')
  else fail('lib/index.mjs 导出结构异常（缺 apply 或 inject）')
}

// ---- 契约 2：PiAiAdapter 构造器仍接受 { profiles, resolveApiKey, resolveAttachments } ----
const { PiAiAdapter } = await import(join(nodeModules, '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js'))
try {
  const adapter = new PiAiAdapter({
    profiles: () => new Map(),
    resolveApiKey: async () => undefined,
    resolveAttachments: () => undefined,
  })
  if (typeof adapter.stream !== 'function') throw new Error('adapter.stream 缺失')
  ok('PiAiAdapter 构造器形状兼容（{ profiles, resolveApiKey, resolveAttachments } + stream）')
} catch (error) {
  fail(`PiAiAdapter 构造器形状不兼容: ${error.message}`)
}

// ---- 契约 3：provider auth 形状（0.82.1 起必须 auth.apiKey.resolve） ----
const { createProvider } = await import(join(nodeModules, '@earendil-works', 'pi-ai', 'dist', 'index.js'))
const { openAICompletionsApi } = await import(join(nodeModules, '@earendil-works', 'pi-ai', 'dist', 'api', 'openai-completions.lazy.js'))
const probe = createProvider({
  id: '__compat_probe__',
  name: 'compat probe',
  baseUrl: 'https://example.invalid',
  auth: {
    apiKey: {
      name: 'compat probe',
      resolve: ({ credential }) =>
        Promise.resolve({ auth: credential?.key === undefined ? {} : { apiKey: credential.key }, source: 'compat probe' }),
    },
  },
  models: [],
  api: openAICompletionsApi(),
})
if (probe?.auth?.apiKey?.resolve === undefined) {
  fail('pi-ai 的 provider auth 契约变化：provider.auth.apiKey.resolve 缺失 → 请求会报 "Provider is not configured"。')
  console.error('       修复：lib/index.mjs buildProvider 里把 auth 组装成 { apiKey: { name, resolve } }。')
} else {
  ok('pi-ai provider auth 契约兼容（auth.apiKey.resolve 存在）')
}
// Provider 接口的流式方法在 createProvider 的返回值上（provider.stream / streamSimple），
// 请求实际走的就是它们；createProvider 返回的对象不含 .api 字段（api 是输入参数）。
if (typeof probe?.stream !== 'function' || typeof probe?.streamSimple !== 'function') {
  fail('pi-ai Provider 接口不再提供 stream/streamSimple（createProvider 返回值缺流式方法）→ 请求无法发出。')
  console.error('       修复：lib/index.mjs 的 buildProvider 组装需随 pi-ai 新契约同步。')
} else {
  ok('pi-ai Provider 接口可流式调用（provider.stream / streamSimple 存在）')
}
// 顺带核对 openAICompletionsApi() 本身仍可调用（懒加载代理，插件以 api: 传入 createProvider）
const api = openAICompletionsApi()
if (typeof api?.stream !== 'function') {
  fail('openAICompletionsApi() 返回不再可流式调用（api.stream 缺失）。')
} else {
  ok('openAICompletionsApi() 可流式调用（api.stream 是函数）')
}

// ---- 契约 4：llm 服务注册 API（实例方法：ctx.llm.registerAdapter 等） ----
const llmMod = await import(join(nodeModules, '@deepseek-ai', 'dsh-llm', 'lib', 'index.js'))
const LlmRuntime = llmMod?.LlmRuntime ?? llmMod?.default
if (LlmRuntime === undefined) {
  fail('dsh-llm 不再导出 LlmRuntime（插件依赖 ctx.llm 服务）。')
} else {
  for (const method of ['registerAdapter', 'registerConfigurableProviders', 'registerModelDiscovery']) {
    if (typeof LlmRuntime.prototype?.[method] === 'function') ok(`dsh-llm LlmRuntime 仍提供 ${method}() 实例方法`)
    else fail(`dsh-llm LlmRuntime 不再提供 ${method}() 实例方法（插件 apply 依赖它）。`)
  }
}

// ---- 契约 5：settings 辅助函数（跨版本：插件用兼容层，两条路径满足其一即可）----
//
// 历史：0.1.1-rc.2 时 dsh-settings 导出 installSettingsSection / settingsNamespace /
// deepEqualJson 三者；0.1.5-rc.1 起全部变动：
//   deepEqualJson          → 搬到 @deepseek-ai/dsh-util-values（函数体逐字节相同）
//   installSettingsSection → 变成 SettingsProvider 实例方法 installSection(owner, ...)
//   settingsNamespace      → 改名 parseSettingsNamespace 且不再导出（校验已内建）
// 插件 lib/index.mjs 内有兼容层（优先新 API、回退旧 API），故此处按「任一满足」判定。
const settingsMod = await import(join(nodeModules, '@deepseek-ai', 'dsh-settings', 'lib', 'index.js'))

// deepEqualJson：旧位置 或 新包，二者有其一即可
let deepEqualOk = typeof settingsMod?.deepEqualJson === 'function'
let deepEqualWhere = deepEqualOk ? 'dsh-settings' : null
if (!deepEqualOk) {
  try {
    const uvMod = await import(join(nodeModules, '@deepseek-ai', 'dsh-util-values', 'lib', 'index.js'))
    if (typeof uvMod?.deepEqualJson === 'function') {
      deepEqualOk = true
      deepEqualWhere = 'dsh-util-values'
    }
  } catch { /* 保持 false */ }
}
if (deepEqualOk) ok(`deepEqualJson 可用（来自 ${deepEqualWhere}）`)
else fail('deepEqualJson 在 dsh-settings 与 dsh-util-values 两处都找不到 → 插件兼容层会抛错。')

// installSettingsSection：三个世代满足其一即可（插件内有三段分支）
const SettingsProvider = settingsMod?.SettingsProvider ?? settingsMod?.default
if (typeof settingsMod?.installSettingsSection === 'function') {
  ok('installSettingsSection() 仍以函数导出（0.1.1-rc.x 路径，分支①）')
} else if (typeof SettingsProvider?.prototype?.installSection === 'function') {
  ok('SettingsProvider 提供 installSection() 实例方法（0.1.5 / 0.1.6 路径，分支②）')
} else if (typeof settingsMod?.SettingsForms === 'function') {
  // 0.1.7+：installSection 被移除，改由 SettingsForms 从插件导出的 Config 自动投影表单。
  const proto = settingsMod.SettingsForms.prototype
  const need = ['configure', 'describe', 'update', 'replace', 'mutate']
  const missing = need.filter((m) => typeof proto?.[m] !== 'function')
  if (missing.length === 0) ok('SettingsForms 提供 configure/describe/update/replace/mutate（0.1.7+ 路径，分支③）')
  else fail(`SettingsForms 缺少方法 ${missing.join(', ')} → 0.1.7+ 的 settings 接线会失败。`)
} else {
  fail('installSettingsSection() / SettingsProvider.installSection() / SettingsForms 三者都不存在 → settings 接线无法建立。')
}

// 0.1.7+ 专属：插件必须导出 Config，且 providers 必须标 volatile，
// 否则 SettingsForms.describe() 会因 volatileForm(schema) === undefined 直接跳过本插件的行，
// 表现为「设置 → 思考 API 整页消失」，且 mutate/update 抛 "has no volatile fields"。
{
  const hasForms = typeof settingsMod?.SettingsForms === 'function'
  if (!hasForms) {
    ok('该 dsh-settings 不校验 volatile（≤0.1.6 用 installSection 显式注册，无此要求）')
  } else if (mod === null || mod.Config === undefined) {
    fail('DSH 0.1.7+ 下插件未导出 Config → SettingsForms 无法投影设置页（「设置 → 思考 API」会整块消失）。')
    console.error('       修复：lib/index.mjs 增加 export const Config = z.object({ providers: …volatile() })')
  } else if (mod.Config?.dict?.providers?.meta?.volatile !== true) {
    fail('导出的 Config.providers 未标记 volatile → 0.1.7+ 设置页看不到、也存不进 CodeBuddy。')
    console.error('       修复：保留三级探测 volatile() → extra("volatile", true) → 原样，见 lib/index.mjs providersSchema')
  } else {
    ok('Config 已导出且 providers 标了 volatile（0.1.7+ 设置页可见可写）')
  }
}

// 0.1.7+ 标记方式的**跨世代**回归守卫。
//
// 背景：DSH 按 profile 的物理 node_modules 解析插件依赖。profile 里可能残留更早世代
// 的 schemastery（3.18.2 既无 .volatile() 也无任何 volatile 逻辑），此时若插件只探测
// .volatile()，就会静默退化成「未标记」；0.1.7 的 volatileForm(schema) 随即返回
// undefined，本插件的设置页整块消失、settings.yaml 的 thinking-api 段（CodeBuddy
// provider 目录）也不会被导入 —— 全程不报错，极难排查（实测踩过一次）。
//
// 这里同时守住两件事：
//   1) 插件源码必须保留三级探测链（volatile → extra('volatile', true) → 原样）；
//   2) 该链在当前解析到的 schemastery 上确实能产出 meta.volatile === true。
// 第 2 条在真实 profile 上跑时用的就是 3.18.2，等于直接复现最恶劣场景。
{
  const pluginSrc = readFileSync(join(pkgRoot, 'lib', 'index.mjs'), 'utf8')
  const hasChain =
    /typeof providersField\.volatile === 'function'/.test(pluginSrc) &&
    /providersField\.extra\('volatile',\s*true\)/.test(pluginSrc)
  if (!hasChain) {
    fail('插件缺少「volatile() → extra("volatile", true)」三级探测链 → 解析到旧 schemastery 时会静默丢失 volatile 标记。')
    console.error('       修复：providersSchema = 探测 .volatile() → 回退 .extra("volatile", true) → 再回退原样。')
    console.error('       说明：3.18.4 的 .volatile() 实现就是 `return this.extra("volatile", true)`，两者等价。')
  } else {
    ok('插件保留三级 volatile 探测链（可容忍 profile 里的旧 schemastery 副本）')
  }

  try {
    const schMod = await import(join(nodeModules, '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'))
      .catch(() => import(join(nodeModules, '@deepseek-ai', 'schemastery', 'lib', 'index.js')))
    const zImpl = schMod.default ?? schMod
    const schVer = JSON.parse(
      readFileSync(join(nodeModules, '@deepseek-ai', 'schemastery', 'package.json'), 'utf8'),
    ).version
    // 复刻插件的探测链，确认在「当前实际解析到的」schemastery 上标记一定成立
    const field = zImpl.dict(zImpl.object({ a: zImpl.string() })).default({})
    const branch =
      typeof field.volatile === 'function' ? 'volatile()'
        : typeof field.extra === 'function' ? "extra('volatile', true)"
          : '原样（无标记能力）'
    const marked = typeof field.volatile === 'function'
      ? field.volatile()
      : typeof field.extra === 'function' ? field.extra('volatile', true) : field
    if (marked?.meta?.volatile !== true) {
      fail(`schemastery ${schVer} 上探测链未能标出 meta.volatile（走的是 ${branch}）→ 0.1.7+ 会整段丢弃本插件配置。`)
    } else {
      ok(`schemastery ${schVer} 上标记成功（走 ${branch}）`)
    }
    // 附带说明该版本 validate 后是否为 Volatile 引用（3.18.2 无 volatile 逻辑，属惰性标记）
    const cfg = zImpl.object({ providers: marked })
    const res = cfg['~standard'].validate({ providers: { probe: { a: 'x' } } })
    const wrapped = Symbol.for('cosmokit.volatile.write') in Object(res.value.providers)
    ok(
      wrapped
        ? `schemastery ${schVer} 支持 volatile：validate 后 providers 为 Volatile 引用`
        : `schemastery ${schVer} 无 volatile 逻辑（≤0.1.6 世代）：meta.volatile 惰性，validate 后仍是普通对象`,
    )
  } catch (error) {
    fail(`volatile 探测链跨世代验证失败: ${error.message}`)
  }
}

// 0.1.7+ 读取路径：providers 在真机上被 .volatile() 换成 cosmokit Volatile 引用，
// 插件必须解包后再枚举，否则会把 { get } 当成 provider 名。
// 这里用真实 schemastery + cosmokit 复现「validate → Volatile → 解包」链路。
if (typeof settingsMod?.SettingsForms === 'function' && mod?.Config !== undefined) {
  try {
    const schMod = await import(join(nodeModules, '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'))
      .catch(() => import(join(nodeModules, '@deepseek-ai', 'schemastery', 'lib', 'index.js')))
    const zImpl = schMod.default ?? schMod
    const cosmo = await import(join(nodeModules, '@deepseek-ai', 'cosmokit', 'lib', 'index.js')).catch(() => null)
    const sample = {
      providers: {
        probe: { displayName: 'probe', baseURL: 'https://example.invalid/v1', models: { 'm-1': { name: 'm-1' } } },
      },
    }
    const validated = mod.Config['~standard'].validate(sample)
    if (validated.issues) throw new Error(`导出的 Config 拒绝了合法配置: ${JSON.stringify(validated.issues)}`)
    const vol = validated.value.providers
    const wrapped = cosmo?.isVolatile ? cosmo.isVolatile(vol) : Symbol.for('cosmokit.volatile.write') in Object(vol)
    if (!wrapped) throw new Error('校验后 providers 不是 Volatile 引用 —— 该 schemastery 未启用 .volatile()')
    // 插件源码里必须有解包逻辑（providersOf / VOLATILE_WRITE）
    const pluginSrc = readFileSync(join(pkgRoot, 'lib', 'index.mjs'), 'utf8')
    if (!/cosmokit\.volatile\.write/.test(pluginSrc) || !/function providersOf/.test(pluginSrc)) {
      throw new Error('插件未解包 Volatile 引用（缺 providersOf / VOLATILE_WRITE）')
    }
    ok('0.1.7+ providers 为 Volatile 引用，插件已解包（providersOf + VOLATILE_WRITE）')
    void zImpl
  } catch (error) {
    fail(`0.1.7+ Volatile 读取链路不成立: ${error.message}`)
  }
}

// settingsNamespace：旧导出函数 或 新版内建校验，三者有其一即可。
// 0.1.7+ 把 namespace 校验内建进 SettingsForms，且不再需要调用方传 ns
// （ns 取 entry.options.id）；插件内的 shim 已自带 NAMESPACE_PATTERN 校验，故此处放行。
if (typeof settingsMod?.settingsNamespace === 'function') ok('settingsNamespace() 仍以函数导出（旧版路径）')
else if (typeof settingsMod?.parseSettingsNamespace === 'function') ok('parseSettingsNamespace() 可用（新版路径）')
else if (typeof SettingsProvider?.prototype?.register === 'function') ok('namespace 校验已内建到 SettingsProvider.register()（新版路径）')
else if (typeof settingsMod?.SettingsForms === 'function') ok('namespace 校验已内建到 SettingsForms（0.1.7+，ns 取 entry.options.id）')
else fail('settings namespace 校验入口全部缺失。')

const credMod = await import(join(nodeModules, '@deepseek-ai', 'dsh-credentials', 'lib', 'index.js'))
if (typeof credMod?.credentialRef === 'function') ok('dsh-credentials 仍导出 credentialRef()')
else fail('dsh-credentials 不再导出 credentialRef()')

// ---- 契约 6：pi-ai profile 形状（0.1.5 起 modelOf() 裸读 profile.modelErrors）----
//
// 背景：DSH 0.1.5 的 dsh-llm-pi-ai 在 modelOf() 里无条件执行
//   const failure = profile.modelErrors.get(model) ?? ...
// 插件无法复用官方 resolveProfiles（缺少 userAgent / compat.supportsDeveloperRole 钩子），
// 只能手工组装 profile，因此必须自己带上这个新字段；缺了它，模型选择器在枚举每个模型
// （ctx.llm.resolveModelInfo → adapter.resolveModel → modelOf）时会抛
// “Cannot read properties of undefined (reading 'get')”，整组 provider 显示「加载失败」。
// 注意：单独调 listModels()（内部走 getModels）是安全的，所以该组「能列出、点开才崩」。
{
  const piAiEntry = probePackage('@deepseek-ai/dsh-llm-pi-ai', 'lib/index.js')
  if (piAiEntry === null) {
    fail('找不到 @deepseek-ai/dsh-llm-pi-ai/lib/index.js，无法核对 profile 形状契约。')
  } else {
    let src = ''
    try {
      src = readFileSync(piAiEntry, 'utf8')
    } catch { /* 保持空串 */ }
    // 该版本是否要求 modelErrors（按源码里是否出现裸读判断）
    const requiresModelErrors = /profile\.modelErrors\s*\.\s*get\(/.test(src)
    if (!requiresModelErrors) {
      ok('该 dsh-llm-pi-ai 版本不要求 profile.modelErrors（0.1.1 及更早的旧路径）')
    } else {
      // 解析插件源码里 buildProfiles 是否提供了该字段
      const pluginSrc = readFileSync(join(pkgRoot, 'lib', 'index.mjs'), 'utf8')
      if (/modelErrors\s*:\s*new Map\(\)/.test(pluginSrc)) {
        ok('插件 buildProfiles 已提供 profile.modelErrors（兼容 0.1.5 模型目录枚举）')
      } else {
        fail('dsh-llm-pi-ai 的 modelOf() 需要 profile.modelErrors，但插件 buildProfiles() 未提供 → 模型选择器会报 “reading \'get\'” 并整组显示「加载失败」。')
        console.error('       修复：lib/index.mjs buildProfiles() 的 resolved.set(...) 里补 modelErrors: new Map()。')
      }
    }
  }
}

// ---- 契约 7：客户端 bundle 依赖（dsh.client.inject 不得声明已移除的模块）----
{
  const pkgJson = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
  const injectList = pkgJson?.dsh?.client?.inject ?? []
  const banned = ['@deepseek-ai/dsh-client-runtime']
  const offenders = (Array.isArray(injectList) ? injectList : []).filter((id) => banned.includes(id))
  if (offenders.length === 0) {
    ok(`dsh.client.inject 未声明已移除的客户端模块（${JSON.stringify(injectList)}）`)
  } else {
    fail(`dsh.client.inject 仍声明已移除的模块 ${offenders.join(', ')} → Web 端会报 “Failed to load plugins”。`)
    console.error('       修复：从 package.json 的 dsh.client.inject 去掉这些模块；createSnapshotStore 改从 @deepseek-ai/dsh-client-store 导入。')
  }
}

// ---- 契约 8：客户端取数面（connection 是否仍暴露 .api）----
//
// 0.1.5 起 connection 只保留 rpc/状态句柄，不再有 .api；面板取数必须走 ctx.remote.*。
// 本项对「插件源码里是否仍引用 connection.api」做静态检查（client bundle 是浏览器代码，
// 无法在 Node 里实例化，故按源码文本判定）。
{
  const clientSrc = readFileSync(join(pkgRoot, 'lib', 'client.js'), 'utf8')
  // 只看非注释行，避免命中解释性注释与反例说明
  const offending = clientSrc
    .split('\n')
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter(({ line }) => /\.api\.(settings|credentials|llm)\b/.test(line) || /\bconnection\b\s*\)\s*\.\s*api\b/.test(line))
  if (offending.length === 0) {
    ok('client.js 未引用 connection.api（已走 ctx.remote.* 命名空间服务）')
  } else {
    fail(`client.js 仍有 ${offending.length} 处 connection.api 取数（行 ${offending.map((o) => o.no).join(', ')}）→ DSH 0.1.5 上会报 “reading \'settings\'”。`)
    console.error('       修复：改走 ctx.remote.settings / ctx.remote.credentials / ctx.remote.llm，返回值按 { ok, value } 解包。')
  }
}

// ---- 清理 ----
try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }

console.log('')
if (failed > 0) {
  console.error(`[check-compat] 结果：${failed} 项不兼容 —— 插件需要随 DSH 升级同步更新。`)
  process.exit(1)
}
console.log('[check-compat] 结果：全部兼容，插件可继续使用。')
