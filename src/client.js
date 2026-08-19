/**
 * Browser half of dsh-subscription-search: a Settings tab that shows the
 * search chain, ChatGPT/Grok subscription OAuth cards, and the Exa API key.
 * Talks to the Host through the loopback-only /subscription-search channel.
 */

window.__ModuleLoader__.load({
  id: 'dsh-subscription-search',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const CHANNEL = '/subscription-search'

    const PROVIDERS = [
      { id: 'openai-codex', displayName: 'ChatGPT Plus/Pro', kind: 'subscription' },
      { id: 'xai', displayName: 'Grok / X subscription', kind: 'subscription' },
      { id: 'exa', displayName: 'Exa', kind: 'apiKey', ref: 'EXA_API_KEY' },
      { id: 'deepseek-official', displayName: 'DeepSeek', kind: 'shared', ref: 'DEEPSEEK_API_KEY' },
    ]

    function createStore() {
      let state = {
        status: 'idle',
        providers: [],
        exaConfigured: false,
        login: null,
        busyProvider: null,
        error: null,
      }
      const listeners = new Set()
      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        update(patch) {
          state = { ...state, ...patch }
          listeners.forEach(listener => listener())
        },
      }
    }

    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    }

    function Section(props) {
      const store = props.store
      const state = useStore(store)
      const [exaDraft, setExaDraft] = React.useState('')
      const [saving, setSaving] = React.useState(false)

      React.useEffect(() => {
        if (state.status !== 'idle') return
        store.update({ status: 'loading' })
        void (async () => {
          try {
            const [authResult, credResult] = await Promise.all([
              props.connection.rpc.call(CHANNEL, 'providers', {}),
              props.connection.api.credentials.describe({ refs: ['EXA_API_KEY', 'DEEPSEEK_API_KEY'] }),
            ])
            if (!authResult.ok) throw new Error(authResult.error.message)
            const credentials = credResult.result.ok ? credResult.result.value.credentials : {}
            const authProviders = authResult.value.providers
            store.update({
              status: 'ready',
              providers: PROVIDERS.map(provider => {
                if (provider.kind === 'subscription') {
                  const auth = authProviders.find(p => p.provider === provider.id)
                  return { ...provider, configured: auth?.configured === true, loginLabel: auth?.loginLabel ?? '' }
                }
                return { ...provider, configured: credentials[provider.ref]?.configured === true }
              }),
              exaConfigured: credentials.EXA_API_KEY?.configured === true,
            })
          } catch (cause) {
            store.update({ status: 'load-failed', error: cause instanceof Error ? cause.message : 'Failed to load search settings.' })
          }
        })()
      }, [state.status, props.connection, store])

      if (state.status === 'idle' || state.status === 'loading') {
        return h('p', null, 'Loading search provider status…')
      }
      if (state.status === 'load-failed') {
        return h('p', { style: errorStyle }, state.error ?? 'Failed to load search provider status.')
      }

      const subscription = state.providers.filter(p => p.kind === 'subscription')
      return h('div', { style: sectionStyle },
        h('h2', null, 'Web Search'),
        h('p', { style: secondaryStyle }, 'Configure search providers and their fallback order.'),
        h('h3', null, 'Search chain'),
        h('p', { style: secondaryStyle }, 'Providers are tried in order. An unavailable provider is skipped; the first successful result wins.'),
        h('table', { style: tableStyle },
          h('thead', null, h('tr', null,
            h('th', { style: thStyle }, 'Provider'),
            h('th', { style: thStyle }, 'Status'),
          )),
          h('tbody', null,
            ...state.providers.map((provider, index) => h('tr', { key: provider.id },
              h('td', { style: tdStyle }, `${index + 1}. ${provider.displayName}`),
              h('td', { style: tdStyle }, provider.configured ? 'Available' : 'Unavailable'),
            )),
          ),
        ),
        h('h3', null, 'Subscription search'),
        h('p', { style: secondaryStyle }, 'Use your ChatGPT or Grok subscription for search. OAuth credentials stay in DSH on this computer.'),
        ...subscription.map(provider => h(SubscriptionCard, {
          key: provider.id,
          provider,
          state,
          store,
          connection: props.connection,
        })),
        h('h3', null, 'Exa API key'),
        h('p', { style: secondaryStyle }, 'Exa is a dedicated search endpoint. Store its API key here; it is used only for search.'),
        h('div', { style: rowStyle },
          h('input', {
            type: 'password',
            autoComplete: 'off',
            value: exaDraft,
            placeholder: 'Enter Exa API key',
            disabled: saving,
            style: inputStyle,
            onChange: event => setExaDraft(event.target.value),
          }),
          h('button', {
            type: 'button',
            disabled: saving || exaDraft.length === 0,
            onClick: async () => {
              setSaving(true)
              try {
                const result = await props.connection.api.credentials.set({ ref: 'EXA_API_KEY', value: exaDraft })
                if (!result.result.ok) throw new Error(result.result.error.message)
                setExaDraft('')
                store.update({ exaConfigured: true })
                state.providers = state.providers.map(p => p.id === 'exa' ? { ...p, configured: true } : p)
                store.update({ providers: state.providers })
              } catch (cause) {
                store.update({ error: cause instanceof Error ? cause.message : 'Failed to save key.' })
              } finally {
                setSaving(false)
              }
            },
          }, saving ? 'Saving…' : state.exaConfigured ? 'Update key' : 'Save'),
        ),
        state.error !== null ? h('p', { style: errorStyle }, state.error) : null,
      )
    }

    function SubscriptionCard(props) {
      const { provider, state, store, connection } = props
      const busy = state.busyProvider === provider.id
      const visible = state.login?.challenge.provider === provider.id ? state.login : null

      if (provider.configured) {
        return h('div', { style: cardStyle },
          h('div', { style: rowStyle },
            h('span', null, provider.displayName),
            h('span', { style: badgeStyle }, 'Connected'),
          ),
          h('button', {
            type: 'button',
            disabled: busy,
            onClick: async () => {
              store.update({ busyProvider: provider.id })
              try {
                const result = await connection.rpc.call(CHANNEL, 'logout', { provider: provider.id })
                if (!result.ok) throw new Error(result.error.message)
                const auth = await connection.rpc.call(CHANNEL, 'providers', {})
                if (auth.ok) {
                  state.providers = state.providers.map(p => {
                    const ap = auth.value.providers.find(x => x.provider === p.id)
                    return ap !== undefined ? { ...p, configured: ap.configured } : p
                  })
                  store.update({ providers: state.providers })
                }
              } catch (cause) {
                store.update({ error: cause instanceof Error ? cause.message : 'Disconnect failed.' })
              } finally {
                store.update({ busyProvider: null })
              }
            },
          }, busy ? 'Disconnecting…' : 'Disconnect'),
        )
      }

      if (visible === null) {
        return h('div', { style: cardStyle },
          h('div', { style: rowStyle },
            h('span', null, provider.displayName),
            h('span', { style: mutedBadgeStyle }, 'Not connected'),
          ),
          h('button', {
            type: 'button',
            disabled: busy,
            onClick: async () => {
              store.update({ busyProvider: provider.id })
              try {
                const result = await connection.rpc.call(CHANNEL, 'start-login', { provider: provider.id })
                if (!result.ok) throw new Error(result.error.message)
                const status = await connection.rpc.call(CHANNEL, 'login-status', { loginId: result.value.challenge.loginId })
                store.update({
                  login: {
                    challenge: result.value.challenge,
                    status: status.ok ? status.value.status : { kind: 'pending', provider: provider.id },
                  },
                })
              } catch (cause) {
                store.update({ error: cause instanceof Error ? cause.message : 'Sign-in failed.' })
              } finally {
                store.update({ busyProvider: null })
              }
            },
          }, busy ? 'Starting sign-in…' : provider.loginLabel || 'Sign in'),
        )
      }

      const { challenge, status } = visible
      const refreshStatus = async () => {
        const result = await connection.rpc.call(CHANNEL, 'login-status', { loginId: challenge.loginId })
        if (!result.ok) return
        const next = result.value.status
        store.update({ login: { challenge, status: next } })
        if (next.kind === 'succeeded') {
          const auth = await connection.rpc.call(CHANNEL, 'providers', {})
          if (auth.ok) {
            state.providers = state.providers.map(p => {
              const ap = auth.value.providers.find(x => x.provider === p.id)
              return ap !== undefined ? { ...p, configured: ap.configured } : p
            })
            store.update({ providers: state.providers })
          }
        }
      }

      React.useEffect(() => {
        if (status.kind !== 'pending') return
        const timer = setInterval(() => { void refreshStatus() }, 2000)
        return () => clearInterval(timer)
      }, [status.kind, challenge.loginId])

      return h('div', { style: cardStyle },
        h('div', { style: rowStyle },
          h('span', null, provider.displayName),
          h('span', { style: mutedBadgeStyle }, 'Signing in'),
        ),
        status.kind === 'succeeded'
          ? h('p', null, 'Subscription connected.')
          : status.kind === 'cancelled'
            ? h('p', null, 'Sign-in cancelled.')
            : h('div', null,
                h('p', null, 'Open the verification page, enter this one-time code, and return here.'),
                h('a', {
                  href: challenge.verificationUri,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                }, 'Open verification page'),
                h('div', { style: rowStyle },
                  h('span', null, 'One-time code: '),
                  h('code', null, challenge.userCode),
                ),
                h('p', null, status.kind === 'pending' ? 'Waiting for authorization…' : ''),
              ),
        status.kind === 'pending'
          ? h('button', {
              type: 'button',
              onClick: async () => {
                const result = await connection.rpc.call(CHANNEL, 'cancel-login', { loginId: challenge.loginId })
                if (result.ok) store.update({ login: { ...visible, status: { kind: 'cancelled', provider: provider.id } } })
              },
            }, 'Cancel sign-in')
          : null,
      )
    }

    const sectionStyle = { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 600 }
    const secondaryStyle = { margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-text-secondary, #6b7280)' }
    const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 13 }
    const thStyle = { textAlign: 'left', padding: '6px 12px 6px 0', borderBottom: '1px solid var(--dsw-border, #e5e7eb)', fontSize: 12 }
    const tdStyle = { textAlign: 'left', padding: '6px 12px 6px 0', borderBottom: '1px solid var(--dsw-border, #e5e7eb)' }
    const cardStyle = { display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 0', borderBottom: '1px solid var(--dsw-border, #e5e7eb)' }
    const rowStyle = { display: 'flex', alignItems: 'center', gap: 8 }
    const badgeStyle = { fontSize: 12, padding: '2px 8px', borderRadius: 4, background: 'var(--dsw-bg-accent, #e0f2fe)', color: 'var(--dsw-text-accent, #0369a1)' }
    const mutedBadgeStyle = { fontSize: 12, padding: '2px 8px', borderRadius: 4, background: 'var(--dsw-bg-muted, #f3f4f6)', color: 'var(--dsw-text-muted, #9ca3af)' }
    const inputStyle = { flex: 1, fontSize: 13, padding: '6px 10px', border: '1px solid var(--dsw-border, #d1d5db)', borderRadius: 4, background: 'var(--dsw-bg-input, #fff)', color: 'var(--dsw-text-primary, #111827)' }
    const errorStyle = { margin: 0, fontSize: 12, color: 'var(--dsw-text-error, #dc2626)' }

    const inject = ['slots', 'connection']

    function apply(ctx) {
      const store = createStore()
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'search',
        order: 12,
        label: () => 'Search',
        inject: () => ({ store, connection: ctx.connection }),
      }, (props) => h(Section, { ...props, store, connection: ctx.connection })))
    }

    return { apply, inject }
  },
})
