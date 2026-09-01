# dsh-subscription-search

Search-only `dsh-subscription-search@1.3.0` for DeepSeek Harness. It keeps the repository/package identity and DSH web provider id `subscription-search`, but no longer owns OAuth, credentials, subscription usage, model routes, quota UI, or API-key entry.

## Install

```sh
npx --yes github:shaomingbo/dsh-subscription-search#v1.3.0
```

The no-argument command installs into the `web` profile. It changes only `dependencies.dsh-subscription-search` and `dsh.profile.bundles`, runs `pnpm install --ignore-scripts`, and never restarts DSH. Then manually restart DSH and force-refresh the existing Web GUI.

```sh
npx --yes github:shaomingbo/dsh-subscription-search#v1.3.0 status
npx --yes github:shaomingbo/dsh-subscription-search#v1.3.0 uninstall
npx --yes github:shaomingbo/dsh-subscription-search#v1.3.0 install --profile web
```

Local development:

```sh
DSH_SUBSCRIPTION_SEARCH_SOURCE="link:$PWD" node ./bin/install.js install --profile web
```

Manual fallback: add `"dsh-subscription-search": "github:shaomingbo/dsh-subscription-search#v1.3.0"` to the target profile's dependencies, add `dsh-subscription-search` to `dsh.profile.bundles`, then run `pnpm install --ignore-scripts` in that profile. Prefer the installer because it is atomic and rolls back dependency-install failures.

## Search chain

The Host provides the Cordis service `searchChain`, implementing protocol `search-chain/v1`:

- `register(backend) -> disposer`
- `list() ->` synchronous, secret-free settings, last-probed backend status, and bounded diagnostics
- `probe() -> Promise<status>` concurrently refreshes callable backend status with bounded deadlines
- `search(request, policy?, signal)`

Default order: ChatGPT → Grok → Ollama → Exa → DeepSeek. Exa, DeepSeek, and Ollama are built in and resolve `EXA_API_KEY`, `DEEPSEEK_API_KEY`, and `OLLAMA_API_KEY` through ordinary DSH credential refs. ChatGPT and Grok are optional callable adapters dynamically registered by an account plugin; this package starts and searches without that plugin.

### Ollama leg

The Ollama adapter calls Ollama's hosted web search API (`POST https://ollama.com/api/web_search`, up to 5 results). It is credential-gated: without a configured `OLLAMA_API_KEY` the leg reports unavailable and the chain falls through without a network request — it joins the orchestration exactly while the credential exists. Create a free key at [ollama.com/settings/keys](https://ollama.com/settings/keys); the free tier draws on your Ollama account quota (no per-search fee; exact limits are not published). Its `status()` probe reads configuration through `describe`, so the value never crosses the check, and the settings UI's status fetch (`probe()`) refreshes the badge on every load. An unreportable describe seam fails open to the search-time credential check. A 200 response without the documented `results` array (observed when quota is exhausted, [ollama#16045](https://github.com/ollama/ollama/issues/16045)) is treated as an invalid response and falls through; a well-formed empty `results` array stays a valid empty success. Existing saved policies keep their order and gain `ollama` at the tail — move it up in the settings UI to spend free quota before Exa credits.

The chain owns ordering, enabled flags, per-backend and total deadlines, fallback, cancellation, empty-result success, and diagnostics. Settings are version 1; there is no DAG. Manage credentials in **Accounts & Usage**. The Search settings section only manages chain policy and shows status/diagnostics.

See [`SPEC.md`](SPEC.md) and [`CONTEXT.md`](CONTEXT.md).
