# Context

## Ubiquitous language

- **SearchChain**: the deep Host module owning execution policy and diagnostics.
- **backend**: a callable search adapter registered on Cordis service `searchChain`, which implements `search-chain/v1`.
- **leg**: one backend attempt within a search.
- **policy**: versioned enabled/order/per-leg-timeout/total-timeout settings.
- **account plugin**: optional owner of account credentials and ChatGPT/Grok callable adapters.
- **compatibility facade**: secret-free forwarding surface for existing dsh-web and RPC consumers.

## Ownership

This package owns SearchChain execution, built-in Exa/DeepSeek/Ollama adapters, search settings/status/diagnostics UI, the `subscription-search` scalar provider adapter, and installer wiring. It does not own accounts, OAuth, credential mutation, subscription usage, LLM routes, or quota presentation.

## Confirmed test seams

1. `search-chain/v1`: registration lifecycle, ordering, deadlines, fallback, cancellation, empty results, exhaustion, bounded diagnostics, credential-gated availability.
2. Host composition/RPC: starts without account plugin, dynamic registration, scalar forwarding, secret-free payloads, versioned settings, probe-backed status reporting.
3. Installer/package: atomic profile-manifest contract, fixed v1.3.0 source, rollback, lifecycle commands, and packed-file completeness.
4. Browser module source: chain/status/diagnostics only; no account, quota, credential, or composer-dock composition.
