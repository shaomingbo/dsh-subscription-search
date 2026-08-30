# dsh-subscription-search

面向 DeepSeek Harness 的纯搜索 `dsh-subscription-search@1.0.0`。保留仓库/包身份与 DSH Web 提供方 id `subscription-search`，但不再拥有 OAuth、凭据同步、订阅用量、模型路由、配额 UI 或 API 密钥输入。

## 安装

```sh
npx --yes github:shaomingbo/dsh-subscription-search#v1.0.0
```

无参数默认安装到 `web` profile。安装器只修改 `dependencies.dsh-subscription-search` 与 `dsh.profile.bundles`，运行 `pnpm install --ignore-scripts`，绝不重启 DSH。完成后请手动重启 DSH，并强制刷新现有 Web GUI。

```sh
npx --yes github:shaomingbo/dsh-subscription-search#v1.0.0 status
npx --yes github:shaomingbo/dsh-subscription-search#v1.0.0 uninstall
npx --yes github:shaomingbo/dsh-subscription-search#v1.0.0 install --profile web
```

本地开发：

```sh
DSH_SUBSCRIPTION_SEARCH_SOURCE="link:$PWD" node ./bin/install.js install --profile web
```

手工兜底：在目标 profile 的 dependencies 中加入 `"dsh-subscription-search": "github:shaomingbo/dsh-subscription-search#v1.0.0"`，在 `dsh.profile.bundles` 中加入 `dsh-subscription-search`，再于 profile 目录运行 `pnpm install --ignore-scripts`。优先使用具备原子写入和失败回滚的安装器。

## 搜索链

Host 提供 Cordis 服务 `searchChain`，实现协议 `search-chain/v1`：

- `register(backend) -> disposer`
- `list() ->` 无秘密的设置、后端状态和有界诊断
- `search(request, policy?, signal)`

默认顺序：ChatGPT → Grok → Exa → DeepSeek。内置 Exa 与 DeepSeek，通过普通 DSH 凭据引用解析 `EXA_API_KEY` 和 `DEEPSEEK_API_KEY`。ChatGPT 与 Grok 由可选账户插件动态注册为可调用后端；账户插件不存在时本包仍可启动和搜索。

搜索链统一负责顺序、启停、单后端/总超时、回退、取消、空结果成功语义与诊断。设置版本为 1，暂不提供 DAG。凭据请前往**账户与用量**管理；搜索设置页只管理链策略并展示状态/诊断。

详见 [`SPEC.md`](SPEC.md) 与 [`CONTEXT.md`](CONTEXT.md)。
