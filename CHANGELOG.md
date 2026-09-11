# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
