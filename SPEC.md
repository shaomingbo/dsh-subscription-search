# Search Chain v1 Specification

## Scope

`dsh-subscription-search@1.1.0` is search-only. OAuth flows/stores, credential synchronization, subscription usage, model-route provisioning, subscription/quota UI, and credential input are out of scope.

## Host protocol

Cordis service key: `searchChain`. Protocol identifier returned by `list()`: `search-chain/v1`.

### `register(backend) -> disposer`

A backend has a stable lowercase id, optional `available(signal)` search-leg gate, optional secret-free `status(signal)` probe (or static status object), and `search(request, signal)`. Status labels are chain-owned rather than copied from backend data. Registering the same id replaces the callable backend. A stale disposer cannot remove its replacement. Disposal is idempotent.

### `list()`

Synchronously returns the protocol id, normalized version-1 settings, backend registration and latest completed availability status, plus a bounded diagnostic history. It never returns requests, response content, credentials, headers, upstream error messages, or arbitrary error codes.

### `probe()`

Concurrently refreshes callable backend status with a bounded per-probe deadline, then resolves to the same secret-free shape as `list()`. Failed, invalid, or timed-out probes become `unknown`; a stale probe cannot overwrite a replacement backend's status.

### `search(request, policy?, signal)`

The chain tries enabled registered backends in order. Unregistered/unavailable, failed, and per-leg timed-out backends fall through. The first valid result wins; a valid empty result is success and stops fallback. Caller cancellation and total timeout abort the active backend and never continue fallback. Exhaustion throws a stable secret-free error.

## Policy

```json
{
  "version": 1,
  "enabled": { "chatgpt": true, "grok": true, "exa": true, "deepseek": true },
  "order": ["chatgpt", "grok", "exa", "deepseek"],
  "perLegTimeoutMs": 60000,
  "totalTimeoutMs": 240000
}
```

No DAG is defined in v1.

## Adapters and compatibility

Exa and DeepSeek adapters are built in and resolve ordinary credential refs. ChatGPT and Grok are not implemented or credentialed here; an optional account plugin dynamically registers callable adapters. The scalar dsh-web provider `subscription-search` forwards to the chain. `/subscription-search` is retained only as a loopback, secret-free status/settings/search facade.
