/**
 * Credential-seam references this plugin owns. Single source of truth for
 * index.js (route provisioning), credential-sync.js (store round-trips), and
 * auth-runtime.js (which attaches them to resolution failures).
 */
export const CREDENTIAL_REFS = {
  'openai-codex': 'OPENAI_CODEX_ACCESS_TOKEN',
  xai: 'GROK_BUILD_ACCESS_TOKEN',
}
