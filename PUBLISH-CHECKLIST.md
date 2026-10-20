# 发布检查清单

在 `npm publish` / 推 GitHub 之前逐项确认。

## 0. 版本号规则（2026-10-19 起，硬性）

**插件版本号 == 所对齐的 DSH 版本号**，逐字符相同。

理由：用户装了 DSH `0.2.1-rc.2`，希望一眼看出插件是否已跟上，而不是翻 changelog。
`0.1.0` – `0.1.10` 属于旧规则（独立递增），`0.1.10` 是最后一个。

- [ ] `package.json` 的 `version` 等于 `peerDependencies` 里的**最高** DSH 版本，
      或在该版本之上多一个补丁段（`0.2.1-rc.2.1` = 对齐 `0.2.1-rc.2` + 纯插件侧修复）
- [ ] CHANGELOG 顶部版本段与之一致
- [ ] `node scripts/check-docs.mjs` 会强制校验；不一致直接 CI 红

升级流程：DSH 从 `0.2.1-rc.2` 升到 `0.2.2` 时 →
① `peerDependencies` 加上 `>=0.2.2 <0.2.3`；② `version` 改成 `0.2.2`（此后纯插件修复用 `0.2.2.1`、`0.2.2.2`…）；
③ CHANGELOG 起一段 `## [0.2.2] - <日期>`；④ 徽章与「支持的 DSH」同步。

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

## 8. GitHub Release（2026-10-19 补记：0.1.2–0.1.9 曾经只有 npm 没有 Release）

> 教训：`git push` + `npm publish` **不会**自动产生 GitHub Release。0.1.2～0.1.9
> 连续八个版本都只发到 npm，Releases 页面停在 v0.1.1，用户从 GitHub 看会觉得项目停更了。

- [ ] 打 tag：`git tag -a v<version> -m "v<version>" <bump 提交>` 后 `git push origin v<version>`
      —— 注意 tag 必须指向**版本 bump 那次提交**，不能指向 main 的 HEAD
- [ ] 建 Release：标题 `v<version>`，正文粘 CHANGELOG 对应段落，并在首行标注 npm 状态
      （`> npm: \`dsh-plugin-thinking-api@<version>\`` 或「未单独发布，随 xx 发布」）
- [ ] 若某版本因故未发 npm，Release 正文必须写明它随哪个版本一起发布

可复用脚本（读 CHANGELOG 自动生成正文）：

```bash
node -e '
const {execSync}=require("child_process");
const fs=require("fs");
const TOK=execSync(`printf "protocol=https\nhost=github.com\n\n" | git credential fill`,{encoding:"utf8"})
  .split("\n").find(l=>l.startsWith("password=")).slice(9);
const c=fs.readFileSync("CHANGELOG.md","utf8");
const heads=[...c.matchAll(/^## \[([^\]]+)\](?: - (\S+))?$/gm)];
const sec={};
for(let i=0;i<heads.length;i++){
  const v=heads[i][1];const s=heads[i].index+heads[i][0].length;
  const e=i+1<heads.length?heads[i+1].index:c.length;
  sec[v]=c.slice(s,e).trim();
}
const v=require("./package.json").version;
fetch(`https://api.github.com/repos/qjf44/dsh-plugin-thinking-api/releases`,{method:"POST",
  headers:{Authorization:`Bearer ${TOK}`,Accept:"application/vnd.github+json","Content-Type":"application/json"},
  body:JSON.stringify({tag_name:`v${v}`,name:`v${v}`,body:sec[v]})})
 .then(r=>r.json()).then(j=>console.log(j.html_url||j.message));
'
```
