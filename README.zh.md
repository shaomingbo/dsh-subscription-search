# dsh-subscription-search

面向 DeepSeek Harness 的纯搜索 `dsh-subscription-search@1.2.0`。保留仓库/包身份与 DSH Web 提供方 id `subscription-search`，但不再拥有 OAuth、凭据同步、订阅用量、模型路由、配额 UI 或 API 密钥输入。

## 安装

```sh
npx --yes github:shaomingbo/dsh-subscription-search#v1.2.0
```

无参数默认安装到 `web` profile。安装器只修改 `dependencies.dsh-subscription-search` 与 `dsh.profile.bundles`，运行 `pnpm install --ignore-scripts`，绝不重启 DSH。完成后请手动重启 DSH，并强制刷新现有 Web GUI。

```sh
npx --yes github:shaomingbo/dsh-subscription-search#v1.2.0 status
npx --yes github:shaomingbo/dsh-subscription-search#v1.2.0 uninstall
npx --yes github:shaomingbo/dsh-subscription-search#v1.2.0 install --profile web
```

本地开发：

```sh
DSH_SUBSCRIPTION_SEARCH_SOURCE="link:$PWD" node ./bin/install.js install --profile web
```

手工兜底：在目标 profile 的 dependencies 中加入 `"dsh-subscription-search": "github:shaomingbo/dsh-subscription-search#v1.2.0"`，在 `dsh.profile.bundles` 中加入 `dsh-subscription-search`，再于 profile 目录运行 `pnpm install --ignore-scripts`。优先使用具备原子写入和失败回滚的安装器。

## 搜索链

Host 提供 Cordis 服务 `searchChain`，实现协议 `search-chain/v1`：

- `register(backend) -> disposer`
- `list() ->` 无秘密的设置、后端状态和有界诊断
- `search(request, policy?, signal)`

默认顺序：ChatGPT → Grok → Ollama → Exa → DeepSeek。内置 Exa、DeepSeek 与 Ollama，通过普通 DSH 凭据引用解析 `EXA_API_KEY`、`DEEPSEEK_API_KEY` 和 `OLLAMA_API_KEY`。ChatGPT 与 Grok 由可选账户插件动态注册为可调用后端；账户插件不存在时本包仍可启动和搜索。

### Ollama 腿

Ollama 适配器调用 Ollama 托管网页搜索 API（`POST https://ollama.com/api/web_search`，最多 5 条结果），并做凭证门控：未配置 `OLLAMA_API_KEY` 时该腿报告不可用，链直接落下一腿、不发任何网络请求——**有凭证才参与整体搜索链的编排**。在 [ollama.com/settings/keys](https://ollama.com/settings/keys) 创建免费 key；免费档计入 Ollama 账户配额（无按次费用，具体限额未公开）。每次搜索都现解析凭据引用，改 key 无需重启；状态徽标还会随 `credentials/reference-updated` 事件实时刷新。HTTP 200 但缺少文档约定的 `results` 数组（配额耗尽时会出现，见 [ollama#16045](https://github.com/ollama/ollama/issues/16045)）按无效响应处理并落下一腿；合法的空 `results` 数组仍视为空结果成功。存量已保存的策略保持原顺序、`ollama` 追加在尾部——可在设置页上移，让免费配额先于 Exa credits 消耗。进程环境变量变化不可观测、不触发事件，徽标在下一次搜索时对齐。

搜索链统一负责顺序、启停、单后端/总超时、回退、取消、空结果成功语义与诊断。设置版本为 1，暂不提供 DAG。凭据请前往**账户与用量**管理；搜索设置页只管理链策略并展示状态/诊断。

详见 [`SPEC.md`](SPEC.md) 与 [`CONTEXT.md`](CONTEXT.md)。
