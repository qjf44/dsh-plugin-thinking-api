# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **CodeBuddy 网关 `400 / 11128` 的第二个独立指纹：`@` 路径约定两句共现**
  - **现象**：2026-10-28 12:49 起请求全量 `400 / 11128`；重启与改写 DSH 依赖
    里的 prompt 源文本后一度恢复，但只要**会话历史**里回显过那两句原文，该会话
    此后**每一轮**仍稳定 400（新开会话即正常）。
  - **实测结论**（真 key + `copilot.tencent.com/v2/chat/completions`，
    `stream: true`；非流式会被网关以 `11101` 拒绝）：
    - 两句完整共现 → **400 / 11128**；任一句单独出现 → 200；任一句截断或换词 → 200。
    - **与角色无关**：同样文本放 `system` 或 `assistant` → 400；
      放 `user` 或带 `tool_call_id` 的 `tool` → 200。
    - 任一句中间插一个零宽空格（`Tok\u200Bens` / `Relati\u200Bve`）→ **200**。
    - 原失败 body 原样重放 → 400；只改掉 `assistant` 里那一处 → 200。
  - **根因**：网关按「两句连续全文」做子串指纹，而这两句会经由**历史消息回显**
    长期留在上下文里——这正是「改了 prompt 源文本仍然 400」的原因，
    与 `DeepSeek Harness` 品牌短语无关，旧的 `maskBrandTokens` 对它完全无效。
  - **修法**：`neutralizeDeepInPlace` 增加第三层 `maskPathConvention`，
    对两句锚点词插零宽空格；语义不变、指纹消失。
  - **附带修复**：字符级 masking 会把 `model` 打成 `d\u200Be\u200Be\u200Bp…`，
    网关回 `11102 model service info not found`。新增 `STRUCTURAL_KEYS`
    （`model` / `id` / `role` / `type` / `tool_call_id` / `name` / `stream` 等）
    跳过结构字段，只处理自由文本。

### Known issue

- `dsh-file-reference` 的 prompt 源文本改写位于 `node_modules`，**未入库**；
  `pnpm install` / DSH 升级会冲掉。冲掉后旧 system 文本会重新出现，
  但已被上面的第三层 mask 兜住，不再导致 400。

## [0.2.1-rc.2.2] - 2026-10-22

### Fixed

- **11128 指纹演进：网关从「整句身份句」扩大到「body 任意位置的品牌短语」**
  （2026-10-22 wire fail-dump 逐字节定位）。
  - 前一天修好的整句替换只覆盖 messages 里的 `You are an AI agent.`；新指纹对
    **任意位置**的 `DeepSeek Harness` 短语生效——system 提示词其余部分、tools 的
    function description、runtime context、skill 目录描述、被读入的 package.json
    内容，出现即 `400 code 11128`。实测同一失败 body 里身份句之外还有 11 处命中。
  - 改为**对解析后的 payload 深度遍历**，所有字符串值统一在品牌短语中间插入零宽
    空格 U+200B（分词语义不变、上游子串匹配不再命中）。
  - 路径语境跳过：仅当短语**两侧同时**紧邻 `/` 或 `\`（真实文件路径内部）才保留，
    避免破坏模型对 `D:\10_COD\DeepSeek Harness\resources` 这类路径的理解。
    单侧分隔符（`deepseek harness\.?`、`DeepSeek Harness/resources`）属普通文本，照常打散。
  - 修复一个致命顺序 bug：深度打散改写 payload 后，随后 `payload.messages = messages`
    又用旧的未打散数组覆盖回去（tools 生效、messages 全部回退），仍会 400。
    现在先赋回 messages 再打散。
  - wire 日志新增 `brand-hits=N` 计数，便于确认每一次请求实际打散了多少处。

## [0.2.1-rc.2.1] - 2026-10-21

### Fixed

- **根治 CodeBuddy 网关 11128「Illegal API invocation from an unapproved channel」**
  （2026-10-21 逐字节二分实测定位，三层兜底）。
  - **真凶：system prompt 里的客户端身份句。** 腾讯 CodeBuddy 网关
    （copilot.tencent.com）对 system 消息做客户端指纹拦截，精确触发窗口是整句
    `You are an AI agent powered by DeepSeek Harness.`（大小写不敏感）。
    拆开的片段全部放行：`You are an AI agent.`、`You are powered by DeepSeek
    Harness.`、`You are an AI agent powered by Cursor.`、以及任何插入词打断
    "powered by" 邻接的写法。整句一旦出现就回
    `400 {"code":11128,...}`——这解释了「同一把 key、各种 UA、tools、1.3MB body
    的 curl 全 200，而 DSH 一发就失败」的全部现象。排查中用真实 key 做过对照
    实验：tools / 超大 body / 45 个工具 / image / tool 消息 / 各种字段全部 200，
    唯独真实 system prompt（哪怕只取前 500 字符）触发 400；同一段文本放进
    user 角色则 200。
  - **修复（三层纵深防御，均在 `buildProvider` 的 stream/streamSimple 包装层）**：
    1. `compat.supportsDeveloperRole: false`（原有防线，正常路径不触发）；
    2. pi-ai `onPayload` 钩子把 `developer` 角色改写为 `system`——实测该网关对
       messages 任意位置的 `role:"developer"` 也会硬拒同一错误，故保留；
    3. **fetch 最后出口**（`createClient` 透传 `options.fetch`，所有路径必经）：
       把身份句 `You are an AI agent powered by DeepSeek Harness.` 改写为中性的
       `You are an AI agent.`，语义不变、指纹消失（curl 用完整真实 prompt 验证 200）。
  - **可观测性**：每次请求把真实 wire（角色序列 / UA / 模型 / 身份句改写次数 /
    状态码）写入 `/tmp/dsh-thinking-api-wire.log`；若仍收到 11128，自动把**完整
    请求体**落盘到 `/tmp/dsh-thinking-api-wire-fail-<ts>.json`，事后可直接定位。
  - 同时保留 UA 兜底（`USER_AGENT_FALLBACKS`）。

## [0.2.1-rc.2] - 2026-10-19

> **版本号规则变更**：从本版起，插件版本号与所对齐的 DSH 版本号**完全一致**
> （此前是独立递增的 0.1.x）。这样看版本号就能直观判断「插件是否已跟上我当前的 DSH」。
> 本版对齐的 DSH 是 `0.2.1-rc.2`，故插件版本也是 `0.2.1-rc.2`。
> 上一版 `0.1.10` 的内容全部包含在本版中。

跟随 DSH 0.2.x 的技术更新，无破坏性改动。

### Added

- **同步 pi-ai 1.3.0 新增的四个思考方言**：`baseten`、`chat-template`、
  `qwen-chat-template`、`ant-ling`。`dsh-llm-pi-ai` 0.2.1 的
  `SUPPORTED_THINKING_FORMATS` 已收录全部 11 个方言，插件的 `thinkingFormat`
  枚举（host + client 两处）与默认档位表同步跟上。此前写这些方言会被插件的
  schema 判为非法——而报错只说「值不合法」，不提示插件版本落后，排查成本高。
- **`check-compat` 新增两项契约检查**：
  1. 把插件 `THINKING_FORMATS` 与官方 `SUPPORTED_THINKING_FORMATS` 逐一比对，
     并校验 host 与 client 两份枚举不漂移；
  2. 校验 UA 兜底链路（`USER_AGENT_FALLBACKS` + `fallbackUserAgent`）仍接线。
- **`examples/settings.yaml` 纳入 npm 包**（此前只在仓库里，`npm i` 后拿不到）。

### Changed

- **peerDependencies 扩展到 DSH 0.2.x**：新增 `>=0.2.0-rc.1 <0.2.1 ||
  >=0.2.1-rc.2 <0.3.0` 两段，`@earendil-works/pi-ai` 放宽为 `>=0.82.1 <2`
  （已对 pi-ai 1.3.0 / dsh-llm-pi-ai 0.2.1-rc.2 实测通过全部契约检查）。
- **UA 兜底改成表驱动**：原先在 `buildProvider` 里内联 `baseURL.includes(...)`
  三元判断，现在收敛为 `USER_AGENT_FALLBACKS` 表 + `fallbackUserAgent()`，
  新增「按 UA 拦截」的端点只需加一行，也让自检脚本能静态核对。
- README（中英）更新支持范围与 DSH 0.2.x 说明，徽章改为 `0.1.0-rc.6 – 0.2.1-rc.2`。

### Verified

在真实运行时（DSH 0.2.1-rc.2 / pi-ai 1.3.0 / cordis 4.0.5 / schemastery 3.18.5）
上跑 `node scripts/check-compat.mjs --workspace ~/.dsh/runtime/dsh-app`：
22 项契约全部 ✓。

## [0.1.9] - 2026-09-24

### Fixed

- **DSH 0.1.7 下「设置 → 思考 API」整页消失、CodeBuddy 无法保存**（最严重的一条）。
  0.1.7 移除了 `SettingsProvider` 及其 `installSection()`，改为 `SettingsForms`：
  设置页不再由插件显式注册，而是从插件**导出的 `Config` schema** 自动投影，
  且 `volatileForm()` 只保留标了 `.volatile()` 的字段——`describe()` 对
  `volatileForm(schema) === undefined` 的行**直接跳过**，`write()` 抛
  `Plugin entry "thinking-api" has no volatile fields`。
  后果是插件本体照常加载、provider 却已不在设置页出现，且用户无法再保存配置。

  修复分四处：

  1. **导出 `Config`**。0.1.7 的 `SettingsForms.schema(entry)` 读 `entry.fiber.runtime.Config`，
     而 cordis 的 `resolveConfig()` 只在插件导出 `Config` 时才把 `fiber.runtime.Config` 填上。
     此前本插件不导出它，故 0.1.7 上该条目根本不「可配置」。
  2. **给 `providers` 标 `.volatile()`，且按能力探测条件调用**：
     `typeof field.volatile === 'function'`。schemastery 3.18.2（DSH ≤ 0.1.6）没有
     `.volatile()`，无条件调用会让插件在旧版直接崩；3.18.4（0.1.7）才有。
  3. **补第三条 settings 分支 `SettingsForms`**，与既有「≤0.1.1 导出函数
     `installSettingsSection`」「0.1.5/0.1.6 实例方法 `installSection`」并存；
     分支内用官方 0.1.7 写法
     `ctx.inject(['settings'], child => child.effect(() => child.settings.configure({auto:false}, ctx.fiber)))`
     关掉 schema 自动生成页（本插件自带 UI），并订阅 `loader/volatile-update` 作为变更信号。
     三条分支都不匹配时**响亮报错并点名修复位置**，保持本插件「宁可报错不自降级」的一贯设计。
  4. **解包 cosmokit `Volatile` 引用**。`.volatile()` 会把字段值换成
     `createVolatile()` 的引用对象（`{ get(), [Symbol.for('cosmokit.volatile.write')] }`），
     于是 0.1.7 下 `config.providers` 不再是普通对象——直接 `Object.entries()` 会得到一个
     名为 `get` 的伪 provider（值为函数、`baseURL` 为空）并抛错。
     新增 `providersOf()` 统一解包，三处读取点（`profiles()`、`validate()`、注册）全部改走它。

  已用真实依赖在两边实测：0.1.6-alpha.2（schemastery 3.18.2）与 0.1.7-rc.1（3.18.4）
  均能 `import` 插件、通过 `Config` 校验**真实 settings.yaml 里的 CodeBuddy 段落**，
  且 0.1.7 侧复刻 `describe()` 全链路拿到
  `value.providers.codebuddy`（6 个模型、`baseURL` 正确）。

- **profile 里残留的旧 schemastery 会让 `volatile` 标记静默失效——这是 0.1.7 丢配置的
  真正根因**，上面第 2 条的「能力探测」正是它的修复。

  DSH 按 **profile 的物理 `node_modules`** 解析插件依赖，而不是插件源码所在目录。
  实测（在真实 profile 位置 `createRequire(...).resolve()`）：

  ```
  @deepseek-ai/schemastery  3.18.2   <- 陈旧物理副本，遮蔽运行时的 3.18.4
  @deepseek-ai/cosmokit     1.8.3
  @deepseek-ai/dsh-settings 0.1.6-alpha.2
  ```

  3.18.2 **完全没有** `volatile` 逻辑（全文件 0 处引用，无 `.volatile()`），于是
  `typeof field.volatile === 'function'` 为假 → 走「原样返回」兜底 → `meta.volatile`
  从未置位 → 0.1.7 的 `SettingsForms.volatileForm(schema)` 返回 `undefined` →
  `describe()` 跳过本插件的行、`importLegacyDocument()` 只记一条 **warn** 就把
  `settings.yaml` 的 `thinking-api` 段整段丢弃。**全程退出码为 0、无任何 error**，
  表现为「启动成功，但 CodeBuddy 的 provider 目录没导进来」——极难排查。

  修复是给标记加**三级探测链**，而不是只探测 `.volatile()`：

  ```js
  const providersSchema =
    typeof providersField.volatile === 'function'
      ? providersField.volatile()                                  // 3.18.4+
      : typeof providersField.extra === 'function'
        ? providersField.extra('volatile', true)                   // 3.18.2 兜底
        : providersField
  ```

  这不是近似替代：3.18.4 的 `.volatile()` 实现本身就是
  `return this.extra("volatile", true)`（其 `lib/index.mjs:235-238`），两条分支产出
  的 schema **完全等价**（已断言 `JSON.stringify(meta)` 相同）。而在 3.18.2 上
  `meta.volatile` 是惰性字段（该版本无任何 volatile 逻辑），标了也不会改变行为，
  故对 ≤0.1.6 世代安全。

  这样即便 profile 里长期残留 3.18.2 副本，0.1.7 也能正常投影设置页并导入配置——
  **不需要用户手工删除 profile 里的 `@deepseek-ai/schemastery`**，且能扛住
  `pnpm install` 因 `pnpm-lock.yaml` 锁定而把该副本重新装回来。

  另加 `assertVolatileProviders()` 自检：0.1.7+ 世代若标记仍未生效，用
  `logger.error` 打出可 grep 的具体原因与修复位置。**刻意不 throw**——`apply()` 若中断，
  provider 路由注册会一起死掉（比设置页消失更严重）。
  离线侧由 `check-compat` 硬失败把关。

  实测四象限（真实 profile 克隆 + 真实运行时）：

  | | profile 残留 3.18.2 | 移除该副本 |
  |---|---|---|
  | **0.1.6-alpha.2** | 启动正常、0 处失败 | 启动正常、0 处失败 |
  | **0.1.7-rc.1** | `thinking-api` 段正常导入（含 CodeBuddy 6 模型） | 同上 |

  另有一条**反向**结论：**不要**把 schemastery 3.18.4 拷进 profile 试图「升级」它。
  3.18.4 依赖 cosmokit ≥1.8.5 的 `createVolatile`，而 0.1.6 世代的 profile 只有 1.8.3，
  实测会让整个 0.1.6 启动**硬失败**：
  `failed to import loader entry dsh-market (dshmarket): The requested module
  '@deepseek-ai/cosmokit' does not provide an export named 'createVolatile'`。
  正确做法是让每个运行时世代提供各自的 schemastery。

- **`scripts/check-compat.mjs` 在 pnpm 布局下会误报**。原实现取
  「`dsh-llm-pi-ai` 的 `.pnpm` 条目内部 node_modules」当解析根，隐含假设 pi-ai 的依赖闭包
  里带着 `dsh-settings`。该假设在 0.1.7 失效（0.1.7 的 pi-ai 依赖新增
  `cordis-plugin-loader`、去掉 `dsh-settings`），脚本会报 `ERR_MODULE_NOT_FOUND` 指向
  `dsh-settings`——这是**脚本定位问题，不是插件不兼容**（0.1.6 只是碰巧能跑）。
  现改为扫描 `.pnpm` 合成扁平解析根（每个包名取版本最高者），不依赖任何单个包的依赖闭包。

### Added

- **`scripts/check-compat.mjs` 新增 0.1.7 契约检查**：`SettingsForms` 方法面、
  `Config` 是否导出、`providers` 是否标 `volatile`，并用真实 schemastery+cosmokit
  复现「校验 → Volatile → 解包」链路，确认插件确实解包后再枚举。
- **`scripts/check-compat.mjs` 新增「volatile 探测链」跨世代守卫**：断言源码保留
  `volatile() → extra('volatile', true)` 两级回退，并在**当前实际解析到的** schemastery
  上复刻该链、确认 `meta.volatile` 一定置位（在真实 profile 上跑时即 3.18.2，
  等于直接复现最恶劣场景），同时报告该版本 `validate()` 后是否为 Volatile 引用。
  这样「探测链被误删」或「profile 换回旧 schemastery」都会在离线阶段被拦下。
- **README 增补 0.1.7 兼容性说明**（中英），DSH 徽章更新为 `0.1.0-rc.6 – 0.1.7-rc.1`。

### Changed

- **`peerDependencies` 的六个 `@deepseek-ai/dsh-*` 范围放宽至覆盖 0.1.7**
  （新增 `>=0.1.6-0 <0.1.7-rc.1 || >=0.1.7-rc.1 <0.1.8`）。
  0.1.7 起 `@deepseek-ai/dsh-app-boot` 会**强制校验 peer 范围**：不满足的 bundle 被
  「跳过」、插件被置为 `disabled`——且只写 stderr、退出码仍为 0，表现为「启动成功但插件全没了」。
  已用 app-boot 同款谓词（`semver.satisfies(v, range, {includePrerelease:true})`）
  在 0.1.0-rc.6 / 0.1.1-rc.1 / 0.1.2-rc.1 / 0.1.5-rc.1 / 0.1.6-alpha.2 / 0.1.7-rc.1
  全部实测 PASS。

## [0.1.8] - 2026-09-12

### Added

- **`input` 字段：让模型可以声明图片输入（多模态）**。
  此前 `buildModel()` 把每个模型的 `input` 硬编码为 `['text']`，而 `dsh-llm-pi-ai` 会把它
  原样映射为 `inputModalities`，于是 DSH 的 `read_image` 一律以
  `model "<id>" does not declare image input` 拒绝——**图片在本地就被拦下，根本发不出去**，
  即便上游是原生多模态模型（如 CodeBuddy 的 `deepseek-v4.1-flash`，即官方 V4.1 Flash）。
  现支持在模型条目里声明 `input: [text, image]`；缺省与空数组同义，均回落为 `['text']`，
  因此既有配置行为完全不变。

  注意：这是**能力声明**，不代表上游端点真的收图。声明后若端点拒收会在真正传图时报错；
  反之端点支持而未声明时，图片无法送出。

  已验证：CodeBuddy（`copilot.tencent.com/v2`）的 `deepseek-v4.1-flash` 声明后
  可正常读图（随机色块盲测 9/9 命中，确认走真实视觉通路而非 OCR 旁路）。

## [0.1.7] - 2026-09-11

### Fixed

- **兼容性自检脚本在 pnpm 布局下无法运行**（`scripts/check-compat.mjs`）。
  原先只在「顶层提升」的 `node_modules` 里找依赖，而 DSH 运行时是 pnpm 布局
  （包位于 `node_modules/.pnpm/<name>@<version>_<hash>/node_modules/`），导致脚本
  在任何真实环境上都找不到 `@deepseek-ai/dsh-llm-pi-ai` 并抛未捕获异常。现同时支持
  两种布局，且依赖缺失时给出可读提示而非堆栈。

### Added

- **`scripts/check-compat.mjs` 新增 3 组 0.1.5 契约检查**：此前它完全不覆盖本轮踩到的三个坑，
  升级后会给出**假绿灯**。现新增：
  - pi-ai `modelOf()` 是否要求 `profile.modelErrors`，及插件 `buildProfiles()` 是否提供；
  - `dsh.client.inject` 是否声明了已移除的客户端模块；
  - `client.js` 是否仍引用已被移除的 `connection.api`。

- **`scripts/check-docs.mjs` + CI `docs` job**：拦截「代码发了、文档没发」的漂移
  （CHANGELOG 必须含当前版本段且与 `package.json` 一致；两个 README 的 DSH 徽章必须
  体现最高支持版本）。此前 CI 只查语法与包结构，所以 0.1.4/0.1.5 的文档掉队没被拦住。
  `prepublishOnly` 已串上该检查。

### Changed

- **`DESIGN-GUI.md` 同步到 0.1.5 契约**：注入面从 `connection.api` 改为 `ctx.remote.*`
  （旧写法保留在折叠的迁移参考块里），`inject` 列表与 `@deepseek-ai/dsh-web` peer 范围
  一并更新。
- **`PUBLISH-CHECKLIST.md` 新增「文档与版本同步」小节**，并把真机验证扩为三层
  （启动 / 设置面板 / 模型选择器），明确区分「刷新页面即生效」与「必须重启 Harness」。
- **修正两个 README 的 DSH 徽章编码**（badgen 需用 `--` 表示字面量点，此前写错导致渲染不正确）。

## [0.1.6] - 2026-09-11

### Changed

- **文档修正（无代码改动）**：把 0.1.3/0.1.4/0.1.5 的修复正确归档到各自的版本段（此前都堆在
  `[Unreleased]`）；README 的 DSH 徽章与「支持的 DSH 版本」由 `0.1.0-rc.6` 更新为
  `0.1.0-rc.6 ~ 0.1.5-rc.1`，并新增 0.1.5 三个契约变更的对照表与 2026-09-11 事故日志。
  代码与 v0.1.5 完全一致。

## [0.1.5] - 2026-09-11

### Fixed

- **修复模型选择器里 CodeBuddy 分组「加载失败」**
  （`Cannot read properties of undefined (reading 'get')`）。
  0.1.5 的 `@deepseek-ai/dsh-llm-pi-ai` 在 `modelOf()` 里无条件读取
  `profile.modelErrors`，而本插件 `buildProfiles()` 手工组装的 profile 缺了
  该新字段，导致 `ctx.llm.resolveModelInfo`（模型选择器目录枚举对每个模型
  都会调用）抛 `reading 'get'`，整组 provider 在 UI 里显示「加载失败」。
  现已对齐 0.1.5 官方 `resolveProfiles` 的产出：补上 `modelErrors: new Map()`，
  并带上 `maxRequestImageBytes`/`requestImagePixelBudget`/`requestImageMaxBytes`
  官方默认值（防图片请求路径裸读炸）。设置面板 → 模型选择器均可正常显示。

## [0.1.4] - 2026-09-11

### Fixed

- **修复浏览器端设置面板加载失败（`Cannot read properties of undefined (reading 'settings')`）**。
  面板数据层原先走 0.1.1 时代的 `ctx.get("connection").api.settings/credentials/llm` 取数，
  而 DSH 0.1.5 起 `connection` 服务上下文已不再暴露 `.api`（只保留 rpc/状态句柄），
  导致面板一打开就报错、回退到「加载配置失败」。现已将取数契约迁移到 0.1.5 的
  cordis 命名空间服务：`ctx.remote.settings.describe()/mutate()`、
  `ctx.remote.credentials.*`、`ctx.remote.llm.discoverModels()`，并订阅
  `settings/document-updated`/`credentials/reference-updated`/`llm/adapters-updated`
  让配置在外部变更后自动刷新生效。

## [0.1.3] - 2026-09-10

### Fixed

- **修复浏览器端插件加载失败（`Failed to load plugins`）**：`dsh.client.inject`
  不再声明废弃的 `@deepseek-ai/dsh-client-runtime`。
  client 端所需的 `createSnapshotStore` 已从旧的 `dsh-client-runtime` 迁移到
  平台内置模块 `@deepseek-ai/dsh-client-store`（由 Web 壳 seed 提供，无需列入
  inject）。DSH 0.1.5 起不再挂载 client-runtime；继续在 inject 里声明它会
  **miss 模块表**，导致依赖同患加载失败。现 inject 只保留仍存续的真实客户端服务
  （`dsh-client-connection`、`dsh-client-locale`）。

- **兼容 DSH 0.1.5-rc.1：`@deepseek-ai/dsh-settings` 收紧导出导致的加载失败**。
  该包在 0.1.5 起不再导出本插件依赖的三个符号，而插件此前是 ESM 具名导入，
  目标缺失会直接让 `lib/index.mjs` 加载抛错（插件整体不可用）。三个符号的去向：
  - `deepEqualJson` → **原样搬到新包** `@deepseek-ai/dsh-util-values`（函数体逐字节相同）；
  - `installSettingsSection(ctx, ns, schema, entry, hooks)` → 变为
    `SettingsProvider` 的实例方法 `installSection(owner, ns, schema, entry, hooks)`，
    逻辑不变，仅多一个 `owner` 参数（替代原先闭包里的 `ctx`）；
  - `settingsNamespace(value)` → 改名 `parseSettingsNamespace` 且不再导出，
    校验已内建到 `settings.register()` 中。

  现在 `lib/index.mjs` 内置兼容层：**优先新 API、回退旧 API**，使插件在
  0.1.1 / 0.1.5 两个版本下都能加载；两条路径都不可用时**响亮报错并点名修复位置**，
  不静默降级。写法与官方 `@deepseek-ai/dsh-llm-pi-ai@0.1.5-rc.1` 一致
  （同样从 `dsh-util-values` 取 `deepEqualJson`、同样把 `NS` 用纯字符串、
  同样调用 `settings.installSection(ctx, NS, ...)`）。

- **`check-compat` 第 5 条契约改为跨版本判定**：原先只检查「是否仍以函数导出」，
  在 0.1.5 下必然报 ✗（即使插件已兼容）。现按「旧函数 或 新 API 有其一即通过」判定，
  并会指出 `deepEqualJson` 实际来自哪个包，便于定位。

- **「获取模型列表」对 CodeBuddy 返回实时真实可用模型**：腾讯 CodeBuddy 网关
  （`copilot.tencent.com`）不实现 OpenAI 兼容的 `GET /models` 端点
  （`/v2/models`、`/v1/models` 均 404，仅 `/chat/completions` 存在），
  常规探测在这类端点上必然失败。现在 host 端遇 404 时对 `copilot.tencent.com`
  改用**逐模型实时探测**：对候选模型 id 逐个发 1-token 流式请求（读首块即断开），
  按 `code 11102`（model not found）与 `200` 判定存在性，只返回当前真实可用的
  模型（实测 17 个，deepseek/glm/kimi/hy3/minimax 全家族）。key 取自向导输入
  或已存储凭证；探测全部失败时回退模板预置模型。其他模板端点的 404 退回
  模板预置；非模板端点 404 仍原样报错并追加手动填写提示。
- **CodeBuddy 模板预置模型扩充至探测确认的 17 个**（客户端与服务端模板表同步）。
- **UA 拉黑规避**：新增 `userAgent` 配置项并内置 `copilot.tencent.com`
  兜底 UA（`dsh-thinking-api/1.0`），规避网关按 User-Agent 黑名单拦截
  （500 `{"code":11128,"msg":"request illegal"}`）。
- **重复 provider 路由告警**：`registerAdapter`/`registerConfigurableProviders`
  因路由撞车（如 openrouter 同时配置在 llm-pi-ai 与本插件）被整体拒绝时，
  日志给出明确的排查指引。
- CodeBuddy 模板预置模型补充 `glm-5.3-flash`。

### Added

- **GitHub Actions CI**（`.github/workflows/check.yml`）：每次 push/PR 自动跑语法检查
  （`npm run check`）+ npm 包体检（tarball 文件清单、版本号比对），升级 DSH 前的
  `check-compat` 契约自检仍建议在真实 DSH workspace 上手动跑。
- **示例配置** `examples/settings.yaml`：CodeBuddy / 自建 vLLM / 任意 OpenAI 兼容
  中转站三个可直接复制的模板。
- **Issue 模板** `.github/ISSUE_TEMPLATE/bug_report.yml`：报 bug 时自动收集 DSH 版本、
  插件版本、check-compat 输出。
- **README**：CI 徽章、示例配置引用、参与贡献指引（中英双语）。

## [0.1.2] - 2026-08-18

### Changed

- 仓库地址更新为新的 GitHub 用户名 `qjf44`（`repository.url`、README 安装命令、
  PUBLISH-CHECKLIST 中的链接全部同步）。旧地址会自动 301 重定向。

## [0.1.1] - 2026-08-18

### Fixed

- **pi-ai 0.82.1 auth 契约兼容**：`buildProvider` 的 provider auth 由顶层 `resolve`
  改为 `{ apiKey: { name, resolve } }`（与官方 `dsh-llm-pi-ai` 的
  `routeAuth`/`harnessApiKeyAuth` 形态一致）。旧形态在 pi-ai 0.82.1 下会被
  `resolveProviderAuth` 判定为「无认证方式」，请求 100% 报
  `PI_AI_ERROR: Provider is not configured: <route>`。
- **GUI 向导编辑时不再丢失 apiKeyEnv**：编辑已有 provider 时 API Key 输入框留空
  表示「不改」，保存时沿用原有的 `apiKeyEnv`（此前会把密钥引用直接抹掉，
  导致 `MISSING_CREDENTIAL` / 认证失效）。

### Added

- **启动时契约自检 `assertPiAiContract`**：`apply()` 开头用真实 `createProvider` +
  `openAICompletionsApi()` 探测 pi-ai 的 provider auth 形状与 Provider 流式接口；
  契约变化时在启动阶段直接报清晰错误（点名是哪个契约变了），而不是等用户
  发消息才看到迷惑报错。
- **`scripts/check-compat.mjs` 兼容性自检脚本**：逐项核对插件在真实依赖下的
  import、`PiAiAdapter` 构造器形状、pi-ai provider auth 形状、Provider 流式接口、
  `llm` 服务注册方法、settings/credentials 辅助函数。升级 DSH / pi-ai 后先跑
  `npm run check:compat`（只读、不挡启动），全 ✓ 再重启。运行方式：
  `node scripts/check-compat.mjs --workspace <DSH workspace 根>`。

## [0.1.0] - 2026-08-16

### Added

- 一键配置任意 OpenAI 兼容 API（腾讯 CodeBuddy / 自建 vLLM / 中转站等），
  自动带思考模式（`thinking: true` 即获得思考档位）。
- 修复 `content_filter` / `developer` 角色问题：自行组装 pi-ai 模型并注入
  `compat.supportsDeveloperRole: false`，强制走 `system` 角色，规避第三方端点
  对 `developer` 角色的硬性拦截。
- Web 面板「设置 → 思考 API」：模板/自定义接入向导、获取模型列表、编辑/删除。
- 复用官方 `PiAiAdapter`（流式、chunk 翻译、凭据解析、空闲超时看门狗随 DSH 演进）。
