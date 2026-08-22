const CREDENTIAL_REFS = {
  'openai-codex': 'OPENAI_CODEX_ACCESS_TOKEN',
  xai: 'GROK_BUILD_ACCESS_TOKEN',
}

/** Keep subscription credentials fresh without coupling unrelated providers. */
export function createCredentialSynchronizer({ auth, credentials, logger }) {
  const inFlight = new Map()

  const sync = (provider, reason) => {
    const active = inFlight.get(provider)
    if (active !== undefined) return active

    const operation = Promise.resolve().then(async () => {
      if (!auth.configured(provider)) return
      const resolved = await auth.resolveOAuth(provider)
      if (resolved === undefined || resolved.apiKey.length === 0) return
      const ref = CREDENTIAL_REFS[provider]
      const current = await credentials.resolve(ref)
      if (current?.value !== resolved.apiKey) {
        await credentials.set(ref, resolved.apiKey)
        logger.info('dsh-subscription-search: synchronized credential %s (%s)', ref, reason)
      }
    })
    const tracked = operation.finally(() => {
      if (inFlight.get(provider) === tracked) inFlight.delete(provider)
    })
    inFlight.set(provider, tracked)
    return tracked
  }

  const background = (provider, reason) => sync(provider, reason).catch(error => {
    logger.warn('dsh-subscription-search: %s sync failed: %s', reason, error instanceof Error ? error.message : String(error))
  })

  return { sync, background }
}
