# dsh-subscription-search

面向 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的 ChatGPT / Grok 订阅 OAuth、模型路由和有序 **ChatGPT → Grok → Exa → DeepSeek** 网页搜索回退。

这是一个 **Host Cordis 组合包**，适用于通过 `npx @deepseek-ai/dsh` 安装的发布版 DSH。它自带设备码登录（不读 Codex/Grok CLI 的 `auth.json`），token 保存在 `$DSH_HOME/.oauth.json`（仅属主可读），把新鲜 access token 同步进 DSH 的凭据服务，并通过 settings 服务按提供方合并地配置 pi-ai 模型路由，不替换你的其他提供方。

它不包含、不上传、不提交任何 token。

## 功能

| 能力 | 说明 |
|---|---|
| ChatGPT 登录 | 在 **设置 → 搜索** 中设备码登录 |
| Grok 登录 | 在 **设置 → 搜索** 中设备码登录（接受 `auth.x.ai` / `accounts.x.ai` / `x.com` 验证页） |
| 模型路由 | `openai-codex`（ChatGPT 订阅）和 `grok-build`（Grok 4.6，推理档位 off/low/medium/high/xhigh） |
| 网页搜索链 | ChatGPT → Grok → Exa → DeepSeek，每次尝试 60 秒预算，工具总预算 250 秒 |
| 搜索设置面板 | 链路状态表、订阅连接/断开、周用量、Exa API 密钥输入 |
| 周用量 | ChatGPT（Codex）与 Grok 的本周剩余额度，显示在订阅卡片和输入框下方 |

## 要求

- Node.js 22.19 或更高
- 通过 `npx @deepseek-ai/dsh` 安装的 DSH（web profile）
- 订阅链路需要 ChatGPT Plus/Pro 或 SuperGrok/X Premium 订阅

## 安装

```bash
npx --yes github:shaomingbo/dsh-subscription-search#v0.1.6
```

不带子命令的 `npx` 等同于 `install`。安装器会：

1. 把本包加入 `~/.dsh/profiles/web/package.json`；
2. 把 `dsh-subscription-search` 加入该 profile 的 `dsh.profile.bundles` 列表；
3. 从 bundle 栈移除已被取代的 `dsh-codex-auth-bridge` 和 `dsh-grok-build-auth-bridge`；
4. 从 `~/.dsh/settings.yaml` 移除 bridge 所有的 `grok-build` / `openai-codex` 路由（你的其他提供方不受影响）；
5. 移除 profile `node_modules` 中指向 DSH 工作区 checkout 的符号链接（checkout 版的 Models 页会调用发布版 Host 不存在的 `providerAuth` RPC）；
6. 在 profile 目录运行 `pnpm install`。

重复执行是幂等的；依赖安装失败时会恢复原 manifest。

### 状态与卸载

```bash
# 查看插件在某个 profile 中的安装状态
npx --yes github:shaomingbo/dsh-subscription-search#v0.1.6 status

# 移除依赖引用、bundle 条目与已安装副本
npx --yes github:shaomingbo/dsh-subscription-search#v0.1.6 uninstall
```

`status` 在插件缺失或只装了一半时以非零码退出；`uninstall` 是幂等的。两个命令都接受与 `install` 相同的参数。

所有命令默认作用于 `web` profile,其他 profile 传 `--profile <名称>`,更换包来源传 `--source <spec>`。本地开发直接用 `link:`:

```bash
npx --yes github:shaomingbo/dsh-subscription-search#v0.1.6 --source link:/绝对路径/checkout
```

重启 `npx @deepseek-ai/dsh web`，打开 **设置 → 搜索**，用 ChatGPT 和 Grok 登录。模型选择器随后会列出 ChatGPT 模型和 `grok-4.6`；`web_search` 按链顺序尝试。

官方插件路径的替代安装：

```bash
dsh plugin --profile web add github:shaomingbo/dsh-subscription-search#v0.1.6
```

## 工作原理

### 登录

插件运行 pi-ai 对 `openai-codex` 和 `xai` 的设备码 OAuth 流程。验证 URL 在展示前会对照硬编码的 HTTPS 来源白名单校验。凭据以 `0600` 模式（目录 `0700`）原子写入 `$DSH_HOME/.oauth.json`。没有任何机密跨越浏览器通道：UI 只会收到登录 id、校验过的验证 URL、一次性代码和无机密状态。

### 模型路由

路由通过 `ctx.settings.update('llm-pi-ai', { providers: ... })` 按提供方合并配置——你已有的 `superacme` / `ollama` / `anthropic` 分节不受影响。

- `openai-codex`：无密钥 profile，pi-ai 使用原生 `openai-codex-responses` 传输层和同步后的 access token。
- `grok-build`：`api: openai-responses`、`baseURL: https://api.x.ai/v1`、`apiKeyEnv: GROK_BUILD_ACCESS_TOKEN`，声明 `grok-4.6` 并包含 `xhigh → high` 推理分发。

在每次 `openai-codex` / `grok-build` 流式请求前，插件解析当前 OAuth token（在存储锁下刷新过期 token），并同步进凭据引用。10 分钟的后台定时器保持凭据新鲜。

### 搜索

插件注册一个 id 为 `subscription-search` 的 `WebSearchProvider`，并把 `web` 行的 `searchProvider` 指向它。该提供方内部按序尝试：

1. **ChatGPT** — Codex Responses（`chatgpt.com/backend-api/codex/responses`）原生 `web_search`，OAuth bearer + 账户选择器；
2. **Grok** — xAI Responses（`api.x.ai/v1/responses`）原生 `web_search`，OAuth bearer；
3. **Exa** — `api.exa.ai/search` 高亮摘要，通过 `EXA_API_KEY`；
4. **DeepSeek** — Anthropic 兼容 Messages（`api.deepseek.com/anthropic/v1/messages`）`web_search` 服务端工具，通过 `DEEPSEEK_API_KEY`（与 DeepSeek 模型路由共用）。

不可用的提供方被跳过，失败或 60 秒超时后继续下一个，调用方取消立即停止，空结果算成功。全部耗尽时抛出只包含提供方 id、状态和安全错误码的有界错误。

`tool-web` 被补丁为 `fetch: false` 和 `searchTimeoutMs: 250000`（四次 60 秒尝试加切换开销）。

### 周用量

订阅连接后，Host 向 ChatGPT / Grok 查询当前周额度（Codex 另带 5 小时窗口），只把百分比和重置时间返回给浏览器。设置 → 搜索 的订阅卡片展示详情；输入框下方（与现有 stats 行同带）显示紧凑剩余。失败只影响用量行，响应不含 token、账户 id 或上游错误正文。

## 环境变量覆盖

| 变量 | 默认值 | 用途 |
|---|---|---|
| `DSH_SUBSCRIPTION_SEARCH_SOURCE` | `github:shaomingbo/dsh-subscription-search#v0.1.6` | 安装器包来源 |
| `DSH_HOME` | `~/.dsh` | Harness 主目录；`.oauth.json` 位于此处 |

## 安全说明

- Token 保存在 `$DSH_HOME/.oauth.json`（`0600`）；只有短期 access token 通过普通凭据服务复制到 `$DSH_HOME/.credentials.yaml`。
- loopback-only 订阅通道拒绝非回环客户端；响应从不包含 token 值、账户 id 或上游错误正文。
- 所有携带凭据的搜索请求都拒绝重定向。
- 如果父环境中导出了 `OPENAI_CODEX_ACCESS_TOKEN` / `GROK_BUILD_ACCESS_TOKEN`，它们会遮蔽可写凭据存储。启动 DSH 前请先取消设置。

## 从 CLI-auth bridge 迁移

如果你之前安装过 `dsh-codex-auth-bridge` 或 `dsh-grok-build-auth-bridge`，安装器会将其从 bundle 栈移除。旧的 CLI `auth.json` 不再被读取；请在 设置 → 搜索 中重新登录。移除不再使用的依赖：

```bash
dsh plugin --profile web remove dsh-codex-auth-bridge dsh-grok-build-auth-bridge
```

## 开发

```bash
npm install
npm test
npm run check
```

## 许可证

MIT
