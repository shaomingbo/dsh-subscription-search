# dsh-subscription-search

ChatGPT / Grok subscription OAuth, model routes, and an ordered **ChatGPT → Grok → Exa → DeepSeek** web-search fallback for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).

This is a **Host Cordis bundle** for the published `npx @deepseek-ai/dsh` installation. It owns its own device-code login (no Codex/Grok CLI `auth.json`), keeps tokens in `$DSH_HOME/.oauth.json` (owner-only), synchronizes fresh access tokens into DSH's credential service, and provisions pi-ai model routes through the settings service without replacing your other providers.

It does not contain, upload, or commit any token.

## What you get

| Capability | Detail |
|---|---|
| ChatGPT login | Device-code sign-in under **Settings → Search** |
| Grok login | Device-code sign-in under **Settings → Search** (accepts `auth.x.ai` / `accounts.x.ai` / `x.com` verification) |
| Model routes | `openai-codex` (ChatGPT subscription) and `grok-build` (Grok 4.6, reasoning off/low/medium/high/xhigh) |
| Web search chain | ChatGPT → Grok → Exa → DeepSeek, each with a 60s attempt budget and a 250s tool budget |
| Search settings panel | Chain status table, subscription connect/disconnect, weekly usage, Exa API key input |
| Weekly usage | ChatGPT (Codex) and Grok remaining weekly allowance, shown on the subscription cards and under the composer |

## Requirements

- Node.js 22.19 or later
- A DSH installation via `npx @deepseek-ai/dsh` (web profile)
- ChatGPT Plus/Pro or SuperGrok/X Premium subscription for the subscription legs

## Install

```bash
npx --yes github:shaomingbo/dsh-subscription-search#v0.1.6
```

Bare `npx` runs `install`. The installer:

1. adds this package to `~/.dsh/profiles/web/package.json`;
2. adds `dsh-subscription-search` to that profile's `dsh.profile.bundles` list;
3. removes the superseded `dsh-codex-auth-bridge` and `dsh-grok-build-auth-bridge` from the bundle stack;
4. removes bridge-owned `grok-build` / `openai-codex` routes from `~/.dsh/settings.yaml` (your other providers stay untouched);
5. removes workspace symlinks to a DSH checkout from the profile `node_modules` (a checkout copy of the Models page calls `providerAuth` RPCs the published host does not expose);
6. runs `pnpm install` in the profile.

Repeat runs are idempotent, and a failed dependency install restores the previous manifest.

### Status and uninstall

```bash
# Whether (and how) the plugin is present in a profile
npx --yes github:shaomingbo/dsh-subscription-search#v0.1.6 status

# Remove the dependency reference, the bundle entry, and the installed copy
npx --yes github:shaomingbo/dsh-subscription-search#v0.1.6 uninstall
```

`status` exits non-zero when the plugin is absent or only partially installed; `uninstall` is idempotent. Both accept the same flags as `install`.

All commands default to the `web` profile; pass `--profile <name>` for another one, or `--source <spec>` to install from a different package source. Local development uses `link:` directly:

```bash
npx --yes github:shaomingbo/dsh-subscription-search#v0.1.6 --source link:/absolute/path/to/checkout
```

Restart `npx @deepseek-ai/dsh web`, open **Settings → Search**, and sign in with ChatGPT and Grok. The model picker then lists the ChatGPT models and `grok-4.6`; `web_search` tries the chain in order.

Alternative installation (official plugin path):

```bash
dsh plugin --profile web add github:shaomingbo/dsh-subscription-search#v0.1.6
```

## How it works

### Login

The plugin runs pi-ai's device-code OAuth flow for `openai-codex` and `xai`. The verification URL is validated against a hardcoded HTTPS origin allowlist before it is shown. Credentials persist in `$DSH_HOME/.oauth.json` with mode `0600` (directory `0700`), written atomically. Nothing secret crosses the browser channel: the UI only ever receives the login id, the validated verification URL, the one-time code, and a secret-free status.

### Model routes

Routes are provisioned through `ctx.settings.update('llm-pi-ai', { providers: ... })`, which merges per provider — your existing `superacme` / `ollama` / `anthropic` sections stay untouched.

- `openai-codex`: keyless profile, so pi-ai uses its native `openai-codex-responses` transport with the synchronized access token.
- `grok-build`: `api: openai-responses`, `baseURL: https://api.x.ai/v1`, `apiKeyEnv: GROK_BUILD_ACCESS_TOKEN`, with `grok-4.6` declared including `xhigh → high` reasoning dispatch.

Before any `openai-codex` / `grok-build` stream, the plugin resolves the current OAuth token (refreshing an expired one under the store lock) and synchronizes it into the credential reference. A 10-minute background timer keeps the credential warm.

### Search

The plugin registers one `WebSearchProvider` id `subscription-search` and switches the `web` row's `searchProvider` to it. The provider internally tries, in order:

1. **ChatGPT** — Codex Responses (`chatgpt.com/backend-api/codex/responses`) with native `web_search`, OAuth bearer + account selector;
2. **Grok** — xAI Responses (`api.x.ai/v1/responses`) with native `web_search`, OAuth bearer;
3. **Exa** — `api.exa.ai/search` with highlights, via `EXA_API_KEY`;
4. **DeepSeek** — Anthropic-compatible Messages (`api.deepseek.com/anthropic/v1/messages`) with the `web_search` server tool, via `DEEPSEEK_API_KEY` (shared with the DeepSeek model route).

An unavailable provider is skipped, a failure or 60s timeout continues to the next, caller cancellation stops immediately, and an empty result counts as success. Exhaustion raises a bounded error containing only provider ids, statuses, and safe codes.

`tool-web` is patched to `fetch: false` and `searchTimeoutMs: 250000` (four 60s attempts plus switching overhead).

### Weekly usage

When a subscription is connected, the host asks ChatGPT and Grok for the current weekly allowance (Codex also reports its 5-hour window) and returns only percentages and reset times. The Settings → Search cards show the detail; a compact readout sits under the composer next to the shipped stats line. Failures stay on that row and never include tokens, account ids, or upstream error bodies.

## Environment overrides

| Variable | Default | Purpose |
|---|---|---|
| `DSH_SUBSCRIPTION_SEARCH_SOURCE` | `github:shaomingbo/dsh-subscription-search#v0.1.6` | Installer package source |
| `DSH_HOME` | `~/.dsh` | Harness home; `.oauth.json` lives here |

## Security notes

- Tokens stay in `$DSH_HOME/.oauth.json` (`0600`); only short-lived access tokens are copied into `$DSH_HOME/.credentials.yaml` through the normal credential service.
- The loopback-only subscription channel rejects non-loopback clients; responses never include token values, account ids, or upstream error bodies.
- Redirects are rejected on every credential-bearing search request.
- If `OPENAI_CODEX_ACCESS_TOKEN` / `GROK_BUILD_ACCESS_TOKEN` are exported in the parent environment, they shadow the writable credential store. Unset them before starting DSH.

## Migrating from the CLI-auth bridges

If you previously installed `dsh-codex-auth-bridge` or `dsh-grok-build-auth-bridge`, the installer removes them from the bundle stack. The old CLI `auth.json` files are no longer read; sign in again under Settings → Search. Remove the now-unused dependencies:

```bash
dsh plugin --profile web remove dsh-codex-auth-bridge dsh-grok-build-auth-bridge
```

## Development

```bash
npm install
npm test
npm run check
```

## License

MIT
