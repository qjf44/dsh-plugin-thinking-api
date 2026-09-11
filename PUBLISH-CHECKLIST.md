# 发布检查清单

在 `npm publish` / 推 GitHub 之前逐项确认。

## 1. 包身份（已定稿，发布前核对一致即可）

- [ ] `package.json` 的 `name`：`dsh-plugin-thinking-api`
- [ ] `package.json` 的 `repository.url`：`git+https://github.com/qjf44/dsh-plugin-thinking-api.git`
- [ ] `cordis.patch.yml` 里的 `name`：`dsh-plugin-thinking-api`（与 package.json 一致）
- [ ] `README.md` / `README.zh-CN.md` 的安装命令：`github:qjf44/dsh-plugin-thinking-api`
- [ ] 四处（name / repository / cordis.patch.yml / README）完全一致

## 2. 依赖版本核对（发布时再查一次）

- [ ] 确认 DSH 当前版本（`~/.dsh/.../node_modules/@deepseek-ai/dsh-llm-pi-ai/package.json` 的 `version`），并核对 `peerDependencies` 范围
- [ ] 确认 pi-ai 版本；若升级，同步更新 `package.json` 的 `peerDependencies` 并重测
- [ ] 跑兼容性自检（升过 DSH/pi-ai 后必做）：
      `node scripts/check-compat.mjs --workspace <DSH workspace 根>`
      任何 ✗ 都必须先修复再发布

## 3. 文档与版本同步（**最容易漏，2026-09-11 实际踩过**）

> 背景：0.1.4 / 0.1.5 发布时，CHANGELOG 的改动仍堆在 `[Unreleased]`、README 徽章与
> 「支持的 DSH 版本」也没跟。CI 不校验文档，所以漏了不会被拦。**npm 包页面展示的 README
> 就是包内那份**——文档不同步，用户看到的就是旧的。

- [ ] `CHANGELOG.md`：本次发布的改动已从 `[Unreleased]` **归入 `## [<version>] - <日期>` 段落**
      （不能留在 Unreleased 里发版）
- [ ] `package.json` 的 `version` 与 CHANGELOG 顶部最新版本段**一致**
- [ ] `README.md` / `README.zh-CN.md` 的 DSH 徽章与「Supported DSH / 支持的 DSH 版本」
      已是当前支持的版本范围（**两个语言都要改**）
- [ ] 若本次修的是兼容性问题：README 的兼容对照表 + Incident log 已补上对应条目
- [ ] 是否所有用户可见变更都写进了 CHANGELOG（含"纯文档版本"也要写）

## 4. 校验（本地 + CI）

```bash
cd dsh-plugin-thinking-api
node --check lib/index.mjs        # 语法
node --check lib/client.js        # 语法（浏览器 bundle）
node --check scripts/check-compat.mjs
npm run check                      # 同上的封装
npm run check:compat -- --workspace ~/.dsh/runtime/dsh-app   # 契约自检（支持 npm 与 pnpm 布局）
npm pack --dry-run                 # 确认 files 白名单只打包预期文件（含 scripts/check-compat.mjs）
```

> 推送后 GitHub Actions（`.github/workflows/check.yml`）会自动再跑一遍语法 + 包体检；
> push 前本地跑一遍、push 后看 CI 绿勾即可。
> ⚠️ CI **不检查文档与版本同步**（见第 3 节），这部分只能靠人工逐项确认。

## 5. 真机验证（必做，mock 无法替代）

1. 在 profile 的 `package.json` 里加依赖 + bundle，重装并重启 Harness；
2. 在 `~/.dsh/settings.yaml` 写一段 `thinking-api` 配置（用你自己的 API）；
3. 从模型选择器选中该 API 的模型，发一条消息；
4. 确认：**无 `content_filter`**、思考模式可切换、工具调用正常；
5. 改一次配置（加/删模型），确认路由集原子更新、不报错；
6. **三层都要看**（只验证第 1 层会漏掉本轮两个 bug）：
   - 启动无 `Failed to load plugins`；
   - 设置 → 思考 API 面板能打开（不报 `reading 'settings'`）；
   - 模型选择器里该 provider **不显示「加载失败」**（不报 `reading 'get'`）。
7. 注意生效方式不同：**client bundle 按内容哈希按请求下发，刷新页面即生效；
   host 端 `lib/index.mjs` 是启动时加载，必须重启 Harness。**

## 6. 发布

```bash
git init && git add -A && git commit -m "feat: one-block OpenAI-compatible API with thinking mode"
git remote add origin https://github.com/qjf44/dsh-plugin-thinking-api.git
git push -u origin main
npm publish --access public          # 可选：发到 npm；或用户直接 github: 引用
```

> 账号开了 2FA 时，需使用**启用了 "Bypass 2FA" 的 granular token**，否则 publish 会报
> `403 ... Two-factor authentication ... is required`。可临时写入项目 `.npmrc`：
> `//registry.npmjs.org/:_authToken=<token>`，**发布后立即删除该文件**。

## 7. README 里声明的已知边界（保持诚实）

- [ ] 插件依赖 `PiAiAdapter` 的构造器形状（未明说稳定的内部契约），README 已声明「升级 DSH 前看 release notes」。
- [ ] 插件只支持 `openai-completions` 协议（第三方 API 的通用形状），不支持 anthropic/responses 等其它协议。

## 附：改动后如何让用户快速上手

用户端只需三步，写进 README 顶部：

1. `package.json` 加 `github:qjf44/dsh-plugin-thinking-api` 依赖 + bundle；
2. `settings.yaml` 写 `thinking-api.providers.<id>`（baseURL + apiKeyEnv + models）；
3. 存储密钥（Web 模型页或 `export`），重启。
