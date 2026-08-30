# dsh-subscription-search

Search-only `dsh-subscription-search@1.1.0` for DeepSeek Harness. It keeps the repository/package identity and DSH web provider id `subscription-search`, but no longer owns OAuth, credentials, subscription usage, model routes, quota UI, or API-key entry.

## Install

```sh
npx --yes github:shaomingbo/dsh-subscription-search#v1.1.0
```

The no-argument command installs into the `web` profile. It changes only `dependencies.dsh-subscription-search` and `dsh.profile.bundles`, runs `pnpm install --ignore-scripts`, and never restarts DSH. Then manually restart DSH and force-refresh the existing Web GUI.

```sh
npx --yes github:shaomingbo/dsh-subscription-search#v1.1.0 status
npx --yes github:shaomingbo/dsh-subscription-search#v1.1.0 uninstall
npx --yes github:shaomingbo/dsh-subscription-search#v1.1.0 install --profile web
```

Local development:

```sh
DSH_SUBSCRIPTION_SEARCH_SOURCE="link:$PWD" node ./bin/install.js install --profile web
```

Manual fallback: add `"dsh-subscription-search": "github:shaomingbo/dsh-subscription-search#v1.1.0"` to the target profile's dependencies, add `dsh-subscription-search` to `dsh.profile.bundles`, then run `pnpm install --ignore-scripts` in that profile. Prefer the installer because it is atomic and rolls back dependency-install failures.

## Search chain

The Host provides the Cordis service `searchChain`, implementing protocol `search-chain/v1`:

- `register(backend) -> disposer`
- `list() ->` synchronous, secret-free settings, last-probed backend status, and bounded diagnostics
- `probe() -> Promise<status>` concurrently refreshes callable backend status with bounded deadlines
- `search(request, policy?, signal)`

Default order: ChatGPT → Grok → Exa → DeepSeek. Exa and DeepSeek are built in and resolve `EXA_API_KEY` and `DEEPSEEK_API_KEY` through ordinary DSH credential refs. ChatGPT and Grok are optional callable adapters dynamically registered by an account plugin; this package starts and searches without that plugin.

The chain owns ordering, enabled flags, per-backend and total deadlines, fallback, cancellation, empty-result success, and diagnostics. Settings are version 1; there is no DAG. Manage credentials in **Accounts & Usage**. The Search settings section only manages chain policy and shows status/diagnostics.

See [`SPEC.md`](SPEC.md) and [`CONTEXT.md`](CONTEXT.md).
