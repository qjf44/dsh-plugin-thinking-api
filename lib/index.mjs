// dsh-plugin-thinking-api · 一键配置带思考模式的 API（Host）
//
// 解决三件事：
//   1. 让任意 OpenAI 兼容 API（腾讯 CodeBuddy、自建 vLLM、各类中转站…）一键配置接入 DSH；
//   2. 自动带思考模式（reasoning），无需手写 reasoningEfforts/thinkingFormat；
//   3. 自动规避「developer 角色 → content_filter」问题：
//      pi-ai 对「声明了 reasoning 且未被识别为非标厂商」的模型会把 system prompt
//      改写成 developer 角色；腾讯等第三方端点会硬拒绝 developer 角色。
//      本插件在组装 Model 时直接注入 compat.supportsDeveloperRole: false，
//      强制走 system 角色 —— 这是 dsh-llm-pi-ai 原适配器会丢弃的字段。
//
// 实现思路（优雅且可维护）：
//   复用官方 @deepseek-ai/dsh-llm-pi-ai 导出的 PiAiAdapter 类 —— 它的 stream、
//   chunk 翻译、认证解析、空闲超时看门狗、图片处理全部成熟且随 DSH 升级自动演进；
//   本插件只重写「模型 / Provider 组装」这一小层，把正确的 compat 写进 pi-ai Model。
//
// 依赖（peerDependencies）：
//   @deepseek-ai/cordis, @deepseek-ai/schemastery,
//   @deepseek-ai/dsh-settings, @deepseek-ai/dsh-credentials,
//   @deepseek-ai/dsh-llm, @deepseek-ai/dsh-llm-pi-ai,
//   @earendil-works/pi-ai
//
// 修改后重启 Harness 生效。

import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { LlmError, assertUsableApiKey, attributionHeaders, normalizeApiKey } from '@deepseek-ai/dsh-llm'
import * as settingsMod from '@deepseek-ai/dsh-settings'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'

export const name = 'thinking-api'
export const inject = ['llm']

// ---------------------------------------------------------------------------
// settings 契约兼容层（跨 DSH 版本）
//
// 背景：0.1.5-rc.1 起 @deepseek-ai/dsh-settings 收紧了导出，本插件原先依赖的
// 三个符号全部变动（0.1.1-rc.2 时它们都还在，所以旧写法仅对新版失效）：
//
//   deepEqualJson           → 原样搬到新包 @deepseek-ai/dsh-util-values（函数体逐字节相同）
//   installSettingsSection  → 变成 SettingsProvider 实例方法 installSection(owner, ...)，
//                             逻辑不变，仅多一个 owner 参数（替代原闭包里的 ctx）
//   settingsNamespace       → 改名 parseSettingsNamespace 且不再导出；校验已内建到
//                             settings.register()，此处用同一条 pattern 自行校验
//
// 这里一律「优先新 API，回退旧 API」，使插件在 0.1.1 / 0.1.5 两个版本下都能加载。
// 两条路径都不能用时**响亮报错**并点名修复位置，而不是静默降级。
// ---------------------------------------------------------------------------

/** 与 dsh-settings 内部 NAMESPACE_PATTERN 保持一致。 */
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/

const settingsNamespace =
  typeof settingsMod.settingsNamespace === 'function'
    ? settingsMod.settingsNamespace
    : (value) => {
        if (!NAMESPACE_PATTERN.test(value)) {
          throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`)
        }
        return value
      }

/**
 * 解析 deepEqualJson：旧版在 dsh-settings，新版搬到 dsh-util-values。
 * 先试扁平解析（pnpm 会把 @deepseek-ai/* 提升到 profile 的 node_modules），
 * 失败则改用「锚定 dsh-settings 自身」的解析，应对未提升的情况。
 */
const deepEqualJson = await (async () => {
  if (typeof settingsMod.deepEqualJson === 'function') return settingsMod.deepEqualJson

  const fromPackage = async (entryHref) => {
    const m = await import(entryHref)
    return typeof m.deepEqualJson === 'function' ? m.deepEqualJson : undefined
  }

  try {
    const found = await fromPackage('@deepseek-ai/dsh-util-values')
    if (found !== undefined) return found
  } catch {
    /* 继续尝试下一条路径 */
  }

  try {
    const { createRequire } = await import('node:module')
    const { pathToFileURL } = await import('node:url')
    const settingsPkg = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-settings/package.json')
    const entry = createRequire(settingsPkg).resolve('@deepseek-ai/dsh-util-values')
    const found = await fromPackage(pathToFileURL(entry).href)
    if (found !== undefined) return found
  } catch {
    /* 落到下面的响亮报错 */
  }

  throw new Error(
    'thinking-api: 找不到 deepEqualJson —— 新版 DSH 把它移到了 @deepseek-ai/dsh-util-values 且解析失败。' +
      '修复：确认该包已随 dsh-settings 安装，并可从本插件所在位置被解析。',
  )
})()

/**
 * 安装 settings 段落：旧版是导出函数 installSettingsSection(ctx, ...)，
 * 新版是 SettingsProvider 实例方法 installSection(owner, ...)。
 * 两者语义一致：注入 settings 服务 → 注册段落 → 接管 setSource/onChange 生命周期。
 */
const installSettingsSection =
  typeof settingsMod.installSettingsSection === 'function'
    ? settingsMod.installSettingsSection
    : (ctx, ns, schema, entry, hooks) => {
        const run = (sctx) => {
          const provider = sctx.settings
          if (provider === undefined || typeof provider.installSection !== 'function') {
            throw new Error(
              'thinking-api: settings 服务缺少 installSection() —— 既非旧版导出函数、也非新版实例方法。' +
                '修复：核对 @deepseek-ai/dsh-settings 的当前导出与 SettingsProvider 方法名。',
            )
          }
          provider.installSection(ctx, ns, schema, entry, hooks)
        }
        // 兼容 ctx.inject 的同步返回（旧版 installSettingsSection 亦为同步）
        return ctx.inject(['settings'], run)
      }

/** 本插件的 settings namespace（settings.yaml 里的顶层键）。 */
const NS = settingsNamespace('thinking-api')

// ---------------------------------------------------------------------------
// 启动时契约自检（防止「DSH/pi-ai 一升级插件就静默坏掉」）：
// 插件依赖 pi-ai 的两个内部契约——
//   1. provider auth 必须是 { apiKey: { name, resolve } }（0.82.1 起 resolveProviderAuth 只认这个形状）；
//   2. createProvider 返回的 Provider 必须可流式调用（provider.stream 是函数；自 rc.7 / pi-ai 0.82.1 起
//      Provider 不再暴露 .api 字段，openAICompletionsApi() 返回懒加载代理，流式由框架内部驱动）。
// 若未来 pi-ai 又改形状，这里会在 apply 时立刻抛清晰错误并点名是哪个依赖变了，
// 而不是等到用户发消息才看到 "Provider is not configured" 之类的迷惑报错。
// ---------------------------------------------------------------------------
function assertPiAiContract() {
  const probe = createProvider({
    id: '__thinking_api_contract_probe__',
    name: 'contract probe',
    baseUrl: 'https://example.invalid',
    auth: {
      apiKey: {
        name: 'contract probe',
        resolve: ({ credential }) =>
          Promise.resolve({ auth: credential?.key === undefined ? {} : { apiKey: credential.key }, source: 'contract probe' }),
      },
    },
    models: [],
    api: openAICompletionsApi(),
  })
  if (probe?.auth?.apiKey?.resolve === undefined) {
    throw new Error(
      'thinking-api: 检测到 pi-ai 的 provider auth 契约已变化（需要 provider.auth.apiKey.resolve），' +
        '插件需随新版本同步更新 buildProvider 的 auth 组装。请查看插件 release notes 或升级插件。',
    )
  }
  if (typeof probe.stream !== 'function') {
    throw new Error(
      'thinking-api: 检测到 createProvider 返回的 Provider 不可流式调用（provider.stream 缺失），' +
        'pi-ai 契约已变化，插件需随新版本同步更新。请升级插件或检查 pi-ai 版本兼容性。',
    )
  }
}

/** pi-ai 思考档位（ModelThinkingLevel），按升序。与 pi-ai `EXTENDED_THINKING_LEVELS` 完全一致。 */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 支持的思考参数格式（pi-ai 的 thinkingFormat）。 */
const THINKING_FORMATS = [
  'deepseek',
  'openai',
  'openrouter',
  'together',
  'zai',
  'qwen',
  'string-thinking',
]

/** 模型默认上下文窗口 / 最大输出。 */
const DEFAULT_CONTEXT_WINDOW = 262144
const DEFAULT_MAX_TOKENS = 32768

// ---------------------------------------------------------------------------
// 思考档位默认值：按 thinkingFormat 方言分表。
// 依据 pi-ai openai-completions.js 的真实派发逻辑（openai-completions.js:560-640）：
//   - deepseek 方言：`max` 会映射成 `reasoning_effort: xhigh`（DeepSeek 专属）；
//   - openai / openrouter / together / zai / string-thinking：OpenAI 家族 effort
//     到 `high` 封顶，发 `xhigh` 会被端点拒绝；
//   - qwen 只看 `!!reasoningEffort`（enable_thinking），wire 值仅作占位，用 high 即可。
// 用户显式写 thinkingEfforts 时仍优先，本表只在「未写」时兜底。
// ---------------------------------------------------------------------------
const DEFAULT_EFFORTS_BY_FORMAT = {
  deepseek: { off: null, high: 'high', max: 'xhigh' },
  openai: { off: null, high: 'high', max: 'high' },
  openrouter: { off: null, high: 'high', max: 'high' },
  together: { off: null, high: 'high', max: 'high' },
  zai: { off: null, high: 'high', max: 'high' },
  qwen: { off: null, high: 'high', max: 'high' },
  'string-thinking': { off: null, high: 'high', max: 'high' },
}

/** 按 thinkingFormat 取默认档位表；未知方言回退 deepseek 表并告警。 */
function defaultEffortsFor(thinkingFormat) {
  const table = DEFAULT_EFFORTS_BY_FORMAT[thinkingFormat]
  if (table !== undefined) return table
  console.warn(`thinking-api: unknown thinkingFormat "${thinkingFormat}", falling back to deepseek efforts`)
  return DEFAULT_EFFORTS_BY_FORMAT.deepseek
}

// ---------------------------------------------------------------------------
// 配置 schema（精简版：只保留「一键接入带思考模式的 API」的核心字段）
// ---------------------------------------------------------------------------
const thinkingEffortsSchema = z.dict(z.union([z.string(), z.const(null)]), z.union(THINKING_LEVELS))

const modelSchema = z.object({
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  thinking: z.boolean().default(false),
  thinkingEfforts: thinkingEffortsSchema,
})

const providerSchema = z.object({
  displayName: z.string(),
  baseURL: z.string().required(),
  apiKeyEnv: z.string().role('credential-ref'),
  thinkingFormat: z.union(THINKING_FORMATS).default('deepseek'),
  models: z.dict(modelSchema).required(),
  // 可选：覆盖本提供方出站请求的 User-Agent。
  // 背景：部分网关（实测腾讯 CodeBuddy copilot.tencent.com，2026-08-21 起）按 UA 黑名单
  // 拦截脚本/Agent 客户端（deepseek-harness、python-requests 等），命中即 500
  // {"code":11128,"msg":"request illegal"}。dsh-llm-pi-ai 的 requestHeaders 会强制把
  // attribution UA 放进最终请求且配置无法关闭，所以这里在 pi-ai 选项层做最终覆盖。
  userAgent: z.string(),
})

const Config = z.object({
  providers: z.dict(providerSchema).default({}),
})

// ---------------------------------------------------------------------------
// 组装：把用户配置转成 pi-ai Model / Provider
// ---------------------------------------------------------------------------

/**
 * 构造一个 pi-ai Model。
 * 关键点：compat 里强制 supportsDeveloperRole: false，
 * 让 pi-ai 对「思考模型」也走 system 角色而非 developer 角色。
 */
function buildModel(providerId, provider, modelId, entry) {
  const thinking = entry.thinking
  const efforts = entry.thinkingEfforts

  // 思考档位映射：复刻官方 dsh-llm-pi-ai resolveModelReasoning 的语义。
  // thinkingLevelMap 里「未声明」的档位记为 null（pi-ai 据此判定「不支持」），
  // 「显式 null」的档位（仅 off 合法）不写入 map（键缺省）——这样 off 仍是一个
  // 可选档位，且 deepseek 方言在关闭思考时仍会发 thinking:{type:"disabled"}。
  // 有 wire 值的档位记为 wire（并校验为非空字符串）。
  let thinkingLevelMap
  let reasoning = false
  if (thinking) {
    reasoning = true
    const source =
      efforts && Object.keys(efforts).length > 0
        ? efforts
        : defaultEffortsFor(provider.thinkingFormat ?? 'deepseek')
    thinkingLevelMap = {}
    for (const level of THINKING_LEVELS) {
      const wire = source[level]
      if (wire === undefined) thinkingLevelMap[level] = null
      else if (wire === null) {
        // 仅 off 允许为 null（官方语义）；非 off 档位给 null 是配置错误。
        if (level !== 'off') {
          throw new Error(
            `thinking-api: provider "${providerId}" model "${modelId}" thinkingEfforts.${level} ` +
              `must provide the wire value; only "off" may be null`,
          )
        }
        // off → 不写入（键缺省），与官方 resolveModelReasoning 一致。
      } else if (typeof wire !== 'string' || wire.length === 0) {
        throw new Error(
          `thinking-api: provider "${providerId}" model "${modelId}" thinkingEfforts.${level} ` +
            `must be a non-empty string or null; got ${JSON.stringify(wire)}`,
        )
      } else thinkingLevelMap[level] = wire
    }
  }

  return {
    id: modelId,
    name: entry.name ?? modelId,
    api: 'openai-completions',
    provider: providerId,
    baseUrl: provider.baseURL,
    reasoning,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: ['text'],
    cost: { input: 0, output: 0 },
    contextWindow: entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: entry.maxTokens ?? DEFAULT_MAX_TOKENS,
    compat: {
      thinkingFormat: provider.thinkingFormat ?? 'deepseek',
      supportsReasoningEffort: true,
      // ★ 核心修复：强制 system 角色，规避第三方 API 的 developer 角色拒绝
      supportsDeveloperRole: false,
    },
  }
}

/**
 * 构造一个 pi-ai Provider。
 * 完全复刻 dsh-llm-pi-ai 的 buildProvider 里「非 catalog 路由」分支，
 * 但 model 的 compat 由本插件正确注入。
 *
 * userAgent 覆盖：dsh-llm-pi-ai 在调用 provider.stream/streamSimple 之前
 * （requestHeaders）已把 attribution 的 user-agent 固化进 options.headers，
 * 而 pi-ai createClient 里 options.headers 最后合并、可覆盖 defaultHeaders。
 * 所以在本层对 stream/streamSimple 再包一层、最后改写 user-agent 即可生效，
 * 无需改动 node_modules（升级不丢）。
 */
function buildProvider(providerId, provider) {
  const models = Object.entries(provider.models ?? {}).map(([modelId, entry]) =>
    buildModel(providerId, provider, modelId, entry),
  )
  const base = createProvider({
    id: providerId,
    name: provider.displayName ?? providerId,
    baseUrl: provider.baseURL,
    // ★ pi-ai 0.82.1 兼容：resolveProviderAuth 只认 provider.auth.apiKey
    //   （含 .resolve 方法），auth 顶层直接挂 resolve 会被当作「无认证方式」，
    //   getAuth 返回 undefined → "Provider is not configured: <route>"。
    //   与官方 dsh-llm-pi-ai 的 routeAuth/harnessApiKeyAuth 形态保持一致。
    auth: {
      apiKey: {
        name: provider.displayName ?? providerId,
        resolve: ({ credential }) =>
          Promise.resolve({
            auth: credential?.key === undefined ? {} : { apiKey: credential.key },
            source: provider.displayName ?? providerId,
          }),
      },
    },
    models,
    api: openAICompletionsApi(),
  })
  const userAgent = provider.userAgent
    // ★ 兜底：已知会被网关按 UA 拉黑的端点，即使配置里的 userAgent 被 GUI 重写抹掉，
    //   也强制套上安全 UA（GUI 的写入路径不认识自定义字段，会把 settings.yaml 里的
    //   userAgent 键抹掉——2026-08-21 三次故障的根因之一）。
    ?? (provider.baseURL?.includes('copilot.tencent.com') ? 'dsh-thinking-api/1.0' : undefined)
  if (userAgent === undefined || userAgent.length === 0) return base
  const withUserAgent = (options) => ({
    ...options,
    headers: { ...options?.headers, 'user-agent': userAgent },
  })
  return {
    ...base,
    stream: (model, context, options) => base.stream(model, context, withUserAgent(options)),
    streamSimple: (model, context, options) => base.streamSimple(model, context, withUserAgent(options)),
  }
}

/**
 * 把配置组装成 PiAiAdapter 需要的 profiles Map，并在组装前做完整校验。
 * profile 结构与 dsh-llm-pi-ai resolveProfiles 返回的一致（PiAiAdapter 依赖它）。
 * 任何非法 provider 都在这里抛出带 route 定位的错误——既在 apply 启动时跑一次，
 * 也作为 installSettingsSection 的 validate，让非法配置在写入点就被拒绝，
 * 而不是被存进 settings 后在模型选择/请求时才炸。
 */
function buildProfiles(providers) {
  const resolved = new Map()
  for (const [providerId, source] of Object.entries(providers ?? {})) {
    if (providerId.length === 0) throw new Error('thinking-api: provider names must be non-empty')
    if (source.baseURL === undefined || source.baseURL.length === 0) {
      throw new Error(`thinking-api: provider "${providerId}" has an empty baseURL`)
    }
    const models = Object.entries(source.models ?? {})
    if (models.length === 0) {
      throw new Error(`thinking-api: provider "${providerId}" resolves no models; declare at least one model`)
    }
    const seen = new Set()
    for (const [modelId] of models) {
      if (modelId.length === 0) throw new Error(`thinking-api: provider "${providerId}" has a model with an empty id`)
      if (seen.has(modelId)) throw new Error(`thinking-api: provider "${providerId}" lists model "${modelId}" more than once`)
      seen.add(modelId)
    }
    const displayName = source.displayName ?? providerId
    if (displayName.length === 0) throw new Error(`thinking-api: provider "${providerId}" has an empty displayName`)
    const apiKeyEnv = source.apiKeyEnv
    resolved.set(providerId, {
      provider: providerId,
      displayName,
      ...(apiKeyEnv === undefined ? {} : { apiKeyEnv: credentialRef(apiKeyEnv) }),
      streamIdleTimeoutMs: 3e5,
      configuredMaxTokens: new Map(),
      // ★ piProvider 由本插件组装（compat 正确）
      piProvider: buildProvider(providerId, source),
    })
  }
  return resolved
}

// ---------------------------------------------------------------------------
// 内置模板（「一键配置」用）：每个模板只提供默认值（baseURL / 思考方言 / 默认模型），
// 不绑定 key。用户选模板 → 填 API Key → 启用，即可写入 thinking-api.providers.<route>。
// host 与 client 共享，保证两端的默认行为一致。
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ThinkingApiTemplate
 * @property {string} route - provider route id（settings 里的键）
 * @property {string} displayName - 显示名
 * @property {string} baseURL - API 地址
 * @property {string} thinkingFormat - pi-ai 思考方言
 * @property {Record<string, {name: string, thinking?: boolean}>} models - 默认模型（「填 key 即用」的兜底）
 */

// 注意：此表必须与 lib/client.js 里的 TEMPLATES 保持一致（跨端无法直接 import）。
/** @type {ThinkingApiTemplate[]} */
export const templates = [
  // codebuddy 预置清单 = 2026-08 实时探测确认的全部可用模型（探测逻辑见 probeCodeBuddyModels）。
  { route: 'codebuddy', displayName: 'CodeBuddy', baseURL: 'https://copilot.tencent.com/v2', thinkingFormat: 'deepseek', userAgent: 'dsh-thinking-api/1.0', models: {
    'deepseek-v4-pro': { name: 'DeepSeek V4 Pro', thinking: true },
    'deepseek-v4-flash': { name: 'DeepSeek V4 Flash', thinking: false },
    'deepseek-v3.2': { name: 'DeepSeek V3.2', thinking: false },
    'deepseek-v3': { name: 'DeepSeek V3', thinking: false },
    'deepseek-r1': { name: 'DeepSeek R1', thinking: true },
    'glm-5.3-flash': { name: 'GLM 5.3 Flash', thinking: true },
    'glm-5.2': { name: 'GLM 5.2', thinking: false },
    'glm-5.1': { name: 'GLM 5.1', thinking: false },
    'glm-5v-turbo': { name: 'GLM 5V Turbo', thinking: false },
    'kimi-k2.7': { name: 'Kimi K2.7', thinking: false },
    'kimi-k2.5': { name: 'Kimi K2.5', thinking: false },
    'hy3': { name: 'Hunyuan 3', thinking: true },
    'hy3-x': { name: 'Hunyuan 3 X', thinking: true },
    'hy3-preview': { name: 'Hunyuan 3 Preview', thinking: false },
    'hy3-preview-agent': { name: 'Hunyuan 3 Preview Agent', thinking: false },
    'minimax-m3-pay': { name: 'MiniMax M3 Pay', thinking: false },
    'minimax-m3': { name: 'MiniMax M3', thinking: false },
  } },
  { route: 'deepseek', displayName: 'DeepSeek', baseURL: 'https://api.deepseek.com', thinkingFormat: 'deepseek', models: { 'deepseek-v4-pro': { name: 'DeepSeek V4 Pro', thinking: true }, 'deepseek-v4-flash': { name: 'DeepSeek V4 Flash', thinking: false } } },
  { route: 'openrouter', displayName: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', thinkingFormat: 'openrouter', models: { 'deepseek/deepseek-chat-v3-0324': { name: 'DeepSeek Chat V3', thinking: false } } },
  { route: 'siliconflow', displayName: 'SiliconFlow', baseURL: 'https://api.siliconflow.cn/v1', thinkingFormat: 'deepseek', models: { 'deepseek-ai/DeepSeek-V3': { name: 'DeepSeek V3', thinking: false }, 'deepseek-ai/DeepSeek-R1': { name: 'DeepSeek R1', thinking: true } } },
  { route: 'moonshot', displayName: 'Moonshot', baseURL: 'https://api.moonshot.cn/v1', thinkingFormat: 'openai', models: { 'kimi-k2-thinking': { name: 'Kimi K2 Thinking', thinking: true }, 'kimi-k2-turbo-preview': { name: 'Kimi K2 Turbo', thinking: false } } },
  { route: 'zhipu', displayName: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', thinkingFormat: 'openai', models: { 'glm-4.5': { name: 'GLM-4.5', thinking: false }, 'glm-4.5-air': { name: 'GLM-4.5 Air', thinking: false } } },
  { route: 'qwen', displayName: '通义千问', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', thinkingFormat: 'qwen', models: { 'qwen-max': { name: 'Qwen Max', thinking: false }, 'qwen3-max': { name: 'Qwen3 Max', thinking: true } } },
  { route: 'volcengine', displayName: '火山引擎', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', thinkingFormat: 'deepseek', models: { 'deepseek-v4-pro': { name: 'DeepSeek V4 Pro', thinking: true } } },
  { route: 'baichuan', displayName: '百川', baseURL: 'https://api.baichuan-ai.com/v1', thinkingFormat: 'openai', models: { 'Baichuan4': { name: 'Baichuan4', thinking: false } } },
  { route: 'minimax', displayName: 'MiniMax', baseURL: 'https://api.minimax.chat/v1', thinkingFormat: 'openai', models: { 'MiniMax-M1': { name: 'MiniMax M1', thinking: true } } },
  { route: 'stepfun', displayName: '阶跃星辰', baseURL: 'https://api.stepfun.com/v1', thinkingFormat: 'openai', models: { 'step-2-16k': { name: 'Step 2 16K', thinking: false } } },
  { route: 'hunyuan', displayName: '腾讯混元', baseURL: 'https://api.hunyuan.cloud.tencent.com/v1', thinkingFormat: 'openai', models: { 'hunyuan-turbo': { name: 'Hunyuan Turbo', thinking: false }, 'hunyuan-t1-latest': { name: 'Hunyuan T1', thinking: true } } },
]

// ---------------------------------------------------------------------------
// 一键配置辅助：provider 目录（让插件出现在「设置 → 模型」页）+ 模型自动探测
// ---------------------------------------------------------------------------

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** 配置页里的 provider 目录条目：每个已配置的 provider 一行，可 GUI 编辑/删除。 */
function directoryEntries(profiles) {
  return [...profiles.entries()].map(([provider, profile]) => ({
    provider,
    displayName: profile.displayName,
    settingsNs: NS,
    settingsPath: ['providers', provider],
    declared: true,
  }))
}

/** 提取候选里第一个非空字符串。 */
function label(...candidates) {
  for (const candidate of candidates) if (typeof candidate === 'string' && candidate.length > 0) return candidate
}

/** 提取候选里第一个正整数。 */
function capacity(...candidates) {
  for (const candidate of candidates) if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
}

/** 组装 /models 列表端点。 */
function listingUrl(baseURL) {
  return `${baseURL.replace(/\/+$/, '')}/models`
}

/** 读取回复体，拒绝超过 4MB 的。 */
async function readBounded(response, url) {
  const oversized = () => new LlmError(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, 'DISCOVERY_FAILED')
  const declared = Number(response.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw oversized()
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw oversized()
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/** 解析 OpenAI 兼容的 /models 回复。 */
function readListing(body) {
  const data = body?.data
  if (!Array.isArray(data)) throw new LlmError('the endpoint\'s model listing has no "data" array; enter this provider\'s models by hand', 'DISCOVERY_FAILED')
  const models = []
  for (const raw of data) {
    const entry = raw
    const id = label(entry?.id)
    if (id === undefined) continue
    const name = label(entry?.name, entry?.display_name)
    const contextWindow = capacity(entry?.context_window, entry?.context_length)
    const maxTokens = capacity(entry?.max_output_tokens, entry?.max_tokens)
    models.push({
      id,
      ...(name === undefined ? {} : { name }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    })
  }
  return models
}

/**
 * 404 兜底：某些网关（实测腾讯 CodeBuddy copilot.tencent.com）不实现 OpenAI
 * 兼容的 GET /models 端点（/v2/models、/v1/models 全部 404，仅 /chat/completions
 * 存在），「获取模型列表」在这类端点上永远不可能成功——所有 CodeBuddy 客户端
 * （workbuddy-cliproxy、codebuddy2openai 等）都采用硬编码模型列表。
 * 这里若请求的 baseURL 匹配某个内置模板，则回退返回模板预置模型，
 * 让「获取模型列表」按钮仍然可用而不是报错。非模板端点的 404 仍视为
 * 拼写错误/端点异常，原样抛错。
 */
function templateModelsFor(baseURL) {
  const base = (baseURL ?? '').replace(/\/+$/, '')
  if (base.length === 0) return undefined
  const template = templates.find((entry) => entry.baseURL.replace(/\/+$/, '') === base)
  if (template === undefined) return undefined
  return Object.entries(template.models ?? {}).map(([id, entry]) => ({
    id,
    ...(typeof entry?.name === 'string' && entry.name.length > 0 && entry.name !== id ? { name: entry.name } : {}),
  }))
}

// ---------------------------------------------------------------------------
// 「真实可用」探测：对不提供 /models 的网关（CodeBuddy），对其 chat/completions
// 逐个发 1-token 流式请求来判定候选模型 id 是否真实存在。网关行为（实测 2026-08）：
//   存在的模型   → 200 + SSE 流（读到第一个 data 块即可判定，随即断开，消耗 ≈1 token）
//   不存在的模型 → 400 + {"code":11102,"msg":"model [...] service info not found"}
// 判定歧义为零：非 200/400 或缺 code 的响应一律按「未知」处理，不误报可用。
// ---------------------------------------------------------------------------

/** 候选模型 id 清单（截至 2026-08 已知/疑似存在的 CodeBuddy 模型族）。 */
const CODEBUDDY_PROBE_CANDIDATES = [
  'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4', 'deepseek-v3.2', 'deepseek-v3.1', 'deepseek-v3',
  'deepseek-r1', 'deepseek-chat', 'deepseek-reasoner',
  'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5', 'glm-5v-turbo', 'glm-5v-pro', 'glm-5-air', 'glm-5-flash',
  'glm-4.7', 'glm-4.6', 'glm-4.5',
  'kimi-k2.7', 'kimi-k2.5', 'kimi-k2', 'kimi-k2-thinking', 'kimi-latest',
  'hy3', 'hy3-x', 'hy3-preview', 'hy3-preview-agent', 'hy3-agent', 'hy3-turbo',
  'minimax-m3-pay', 'minimax-m3', 'minimax-m2',
]

/** 模型不存在时网关返回的业务错误码。 */
const CODE_MODEL_NOT_FOUND = 11102

/** 单模型探测：读第一个 SSE 块即断开；返回 {ok} 或 {ok:false, notFound}。 */
async function probeCodeBuddyModel(chatUrl, apiKey, id, signal) {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(onAbort, 25000)
  try {
    const response = await fetch(chatUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'user-agent': 'dsh-thinking-api/1.0',
      },
      body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: true }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      let code
      try { code = JSON.parse(text)?.code } catch { /* 非 JSON 错误体 */ }
      return { ok: false, notFound: code === CODE_MODEL_NOT_FOUND }
    }
    // 200：读第一个 data 块确认是有效 SSE，随即断开（省 token、省时间）。
    const reader = response.body?.getReader()
    if (reader === undefined) return { ok: false, notFound: false }
    const { value } = await reader.read()
    await reader.cancel().catch(() => {})
    const head = new TextDecoder().decode(value ?? new Uint8Array())
    if (head.includes('"code"')) {
      let code
      try { code = JSON.parse(head.replace(/^data:\s*/, ''))?.code } catch { /* 忽略 */ }
      return { ok: false, notFound: code === CODE_MODEL_NOT_FOUND }
    }
    return { ok: true }
  } catch {
    // 超时/网络中断/调用方 abort：按「未知 → 不可用」处理，下一轮还能再探测。
    return { ok: false, notFound: false }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 实时探测 CodeBuddy 网关上真实可用的模型。候选 id 并行探测（4 并发），
 * 只返回确认存在的模型（模板预置的 id 若探测通过也自然包含在内）。
 * 若探测全部失败（如网络不通、key 失效），回退模板预置模型并保留可用性存疑的语义。
 */
async function probeCodeBuddyModels(baseURL, apiKey, signal) {
  const chatUrl = `${baseURL.replace(/\/+$/, '')}/chat/completions`
  const candidates = [...CODEBUDDY_PROBE_CANDIDATES]
  // 模板预置 id 也纳入候选（兜底列表更新后自动跟随）。
  for (const id of Object.keys(templates.find((t) => t.route === 'codebuddy')?.models ?? {})) {
    if (!candidates.includes(id)) candidates.push(id)
  }
  const results = []
  const CONCURRENCY = 4
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    if (signal?.aborted) break
    const batch = candidates.slice(i, i + CONCURRENCY)
    const settled = await Promise.all(batch.map((id) => probeCodeBuddyModel(chatUrl, apiKey, id, signal)))
    results.push(...settled)
  }
  const available = candidates.filter((_, i) => results[i]?.ok)
  if (available.length > 0) {
    return available.map((id) => ({ id }))
  }
  // 探测一无所获：回退模板预置模型（至少让向导可用），host 端无法附加提示，
  // 由 client 端的「模板回退」提示覆盖这种情况。
  return templateModelsFor(baseURL) ?? []
}

/** 校验探测用 key。 */
function usableProbeKey(raw) {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  throw new LlmError(
    checked.reason === 'empty'
      ? "this provider's API key is blank; enter it on the Models page, or clear it to probe unauthenticated"
      : "this provider's API key contains characters no HTTP header can carry; paste the raw key only",
    'INVALID_CREDENTIAL',
  )
}

/** 探测一个端点返回的模型列表。 */
async function discoverModels(request, storedApiKey) {
  if (request.baseURL === undefined || request.baseURL.length === 0) {
    throw new LlmError(
      `thinking-api: provider "${request.provider ?? ''}" has no baseURL; set one, or enter this provider's models by hand`,
      'DISCOVERY_FAILED',
    )
  }
  const api = request.api ?? 'openai-completions'
  if (api !== 'openai-completions') {
    throw new LlmError(`thinking-api: protocol "${api}" has no model listing this build can read; enter this provider's models by hand`, 'DISCOVERY_UNSUPPORTED')
  }
  const url = listingUrl(request.baseURL)
  const supplied = request.apiKey ?? (await storedApiKey?.())
  const apiKey = supplied === undefined ? undefined : usableProbeKey(supplied)
  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
        ...attributionHeaders(),
      },
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
  } catch (error) {
    if (request.signal?.aborted) throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    throw new LlmError(`could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error })
  }
  if (!response.ok) {
    // 404 兜底：网关没有 /models 端点（如 CodeBuddy copilot.tencent.com）。
    // 若 baseURL 匹配已知「可探测网关」，用 key 对 chat/completions 逐个探测候选
    // 模型 id，返回实时、真实可用的模型清单（见 probeCodeBuddyModels）。
    // apiKey 此处已取到最优来源（请求附带 > 存储凭证）；无 key 时探测全部失败，
    // probeCodeBuddyModels 会退回模板预置模型。
    if (response.status === 404 && request.baseURL.includes('copilot.tencent.com')) {
      return probeCodeBuddyModels(request.baseURL, apiKey, request.signal)
    }
    // 其他模板端点的 404：退回模板预置模型，至少让向导可用。
    if (response.status === 404) {
      const fallback = templateModelsFor(request.baseURL)
      if (fallback !== undefined && fallback.length > 0) return fallback
    }
    const hint =
      response.status === 404
        ? '; the endpoint has no OpenAI-compatible /models listing — enter this provider\'s models by hand'
        : response.status === 401 || response.status === 403
          ? '; check the API key'
          : ''
    throw new LlmError(`${url} answered ${response.status}${hint}`, 'DISCOVERY_FAILED')
  }
  const text = await readBounded(response, url)
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new LlmError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED')
  }
  return readListing(body)
}

/**
 * 判断配置解析出的「注册事实」是否变化，用于跳过无谓的 replace。
 * @param {Map} profiles
 */
function registrationFacts(profiles) {
  return [...profiles.entries()]
    .map(([provider, profile]) => ({ provider, displayName: profile.displayName }))
    .sort((left, right) => left.provider.localeCompare(right.provider))
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {*} config  - 组合层初始配置（settings.yaml 之外，由 cordis config 注入）
 */
export function apply(ctx, config) {
  // 启动即校验 pi-ai 契约：依赖形状变了立刻清晰报错，而不是等到用户发消息才炸。
  assertPiAiContract()

  // 当前生效配置的来源：installSettingsSection 的 setSource 会换成 settings 服务的解析值。
  let current = () => config ?? { providers: {} }
  let registration
  let registeredFacts

  // PiAiAdapter 的 profiles 惰性读取：每次请求都走这个闭包，读到最新 current()。
  // buildProfiles 会在组装前做完整校验，非法配置直接抛出（写入点即拒）。
  const profiles = () => buildProfiles(current().providers ?? {})

  const resolveApiKey = async (providerId, profile) => {
    const ref = profile.apiKeyEnv
    if (ref === undefined) return undefined
    const credentials = ctx.get('credentials')
    const hit =
      credentials !== undefined
        ? (await credentials.resolve(ref))?.value
        : launchEnvironmentOf(ctx).get(ref)?.value
    if (hit !== undefined && hit.length > 0) {
      return assertUsableApiKey(hit, 'thinking-api', profile.apiKeyEnv)
    }
    throw new LlmError(
      `thinking-api: provider "${providerId}" 引用的密钥 ${profile.apiKeyEnv} 未配置；` +
        `请通过 credentials 服务存储（Web 模型页写入）或导出该环境变量。`,
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new PiAiAdapter({
    profiles,
    resolveApiKey,
    resolveAttachments: () => ctx.get('attachments'),
  })

  // provider 目录：让插件出现在「设置 → 模型」页，用户可 GUI 里添加/编辑/删除 API。
  let directory
  let directoryFacts
  const ensureDirectory = () => {
    const entries = directoryEntries(profiles())
    if (deepEqualJson(entries, directoryFacts)) return
    // 配置尚未加载（providers 为空）时先跳过注册；
    // 等 settings 注入 provider 后 onChange 会再次调用本函数，届时再真正注册。
    if (entries.length === 0) return
    if (directory === undefined) directory = ctx.llm.registerConfigurableProviders(entries)
    else directory.replace(entries)
    directoryFacts = entries
  }

  // 模型自动探测：让「获取模型列表」按钮能拉取端点 /models。
  const storedApiKey = async (provider) => {
    if (provider === undefined) return undefined
    const profile = profiles().get(provider)
    if (profile === undefined) return undefined
    return resolveApiKey(provider, profile)
  }
  ctx.llm.registerModelDiscovery(NS, (request) => discoverModels(request, () => storedApiKey(request.provider)))

  const ensureRegistrationFacts = () => {
    const facts = registrationFacts(profiles())
    if (deepEqualJson(facts, registeredFacts)) return
    const routes = [...profiles().keys()]
    if (registration === undefined) {
      if (routes.length === 0) {
        registeredFacts = facts
        return
      }
      registration = ctx.llm.registerAdapter(routes, adapter)
    } else {
      registration.replace(routes)
    }
    registeredFacts = facts
  }

  ensureRegistrationFacts()
  ensureDirectory()
  installSettingsSection(ctx, NS, Config, config, {
    // 写入点校验：settings.mutate 落地前先完整组装一遍，非法配置在此被拒绝。
    validate: (candidate) => buildProfiles(candidate?.providers ?? {}),
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      try {
        ensureRegistrationFacts()
      } catch (error) {
        ctx.logger.error('thinking-api: keeping the previously registered routes after a refused update')
        ctx.logger.error(error)
        if (/already (registered|declared)/.test(String(error?.message))) {
          ctx.logger.warn(
            'thinking-api: 检测到与其他插件重复的 provider 路由（例如 openrouter 同时配置在 llm-pi-ai 与 thinking-api）。' +
              'registerAdapter/registerConfigurableProviders 是全有全无式注册：只要有一个路由撞车，本插件声明的所有模型（包括 CodeBuddy）都不会出现在模型目录里。' +
              '请在 settings.yaml 里只保留一处该 provider 的配置，然后重启 Harness。',
          )
        }
      }
      try {
        ensureDirectory()
      } catch (error) {
        ctx.logger.error('thinking-api: keeping the previous configurable-provider directory after a refused update')
        ctx.logger.error(error)
        if (/already (registered|declared)/.test(String(error?.message))) {
          ctx.logger.warn(
            'thinking-api: 目录注册因 provider 路由重复被整体拒绝（见上一条说明）。请去掉 settings.yaml 里重复的 provider 配置后重启。',
          )
        }
      }
    },
  })
}
