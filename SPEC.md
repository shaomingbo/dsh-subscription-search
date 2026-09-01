# Search Chain v1 Specification

## Scope

`dsh-subscription-search@1.2.0` is search-only. OAuth flows/stores, credential synchronization, subscription usage, model-route provisioning, subscription/quota UI, and credential input are out of scope.

## Host protocol

Cordis service key: `searchChain`. Protocol identifier returned by `list()`: `search-chain/v1`.

### `register(backend) -> disposer`

A backend has a stable lowercase id, optional availability function, and `search(request, signal)`. Status labels are chain-owned rather than copied from backend data. Registering the same id replaces the callable backend. A stale disposer cannot remove its replacement. Disposal is idempotent.

### `list()`

Returns protocol id, normalized version-1 settings, backend registration/availability status, and a bounded diagnostic history. It never returns requests, response content, credentials, headers, upstream error messages, or arbitrary error codes.

### `search(request, policy?, signal)`

The chain tries enabled registered backends in order. Unregistered/unavailable, failed, and per-leg timed-out backends fall through. The first valid result wins; a valid empty result is success and stops fallback. Caller cancellation and total timeout abort the active backend and never continue fallback. Exhaustion throws a stable secret-free error.

## Policy

```json
{
  "version": 1,
  "enabled": { "chatgpt": true, "grok": true, "ollama": true, "exa": true, "deepseek": true },
  "order": ["chatgpt", "grok", "ollama", "exa", "deepseek"],
  "perLegTimeoutMs": 60000,
  "totalTimeoutMs": 240000
}
```

No DAG is defined in v1.

## Adapters and compatibility

Exa, DeepSeek, and Ollama adapters are built in and resolve ordinary credential refs. The Ollama adapter gates on `OLLAMA_API_KEY` presence: `available()` re-resolves the ref per operation, an unconfigured key marks the leg unavailable without a network request, and the host refreshes the status badge from the public `credentials/reference-updated` event. A 200 response lacking the documented `results` array (seen on exhausted quota, ollama#16045) is an invalid response and falls through; a well-formed empty array is a valid empty success. ChatGPT and Grok are not implemented or credentialed here; an optional account plugin dynamically registers callable adapters. The scalar dsh-web provider `subscription-search` forwards to the chain. `/subscription-search` is retained only as a loopback, secret-free status/settings/search facade.
