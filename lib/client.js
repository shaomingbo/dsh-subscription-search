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
    const NS = 'dsh-subscription-search'

    const en = {
      nav: 'Search',
      title: 'Web Search',
      intro: 'Configure search providers and their fallback order.',
      chainTitle: 'Search chain',
      chainIntro: 'Providers are tried in order. An unavailable provider is skipped; the first successful result wins.',
      providerHeader: 'Provider',
      statusHeader: 'Status',
      statusAvailable: 'Available',
      statusUnavailable: 'Unavailable',
      providerChatGPT: 'ChatGPT Plus/Pro',
      providerGrok: 'Grok / X subscription',
      providerExa: 'Exa',
      providerDeepSeek: 'DeepSeek',
      subscriptionsTitle: 'Subscription search',
      subscriptionsIntro: 'Use your ChatGPT or Grok subscription for search. OAuth credentials stay in DSH on this computer.',
      subscriptionConnected: 'Connected',
      subscriptionDisconnected: 'Not connected',
      subscriptionConnecting: 'Starting sign-in…',
      subscriptionDisconnect: 'Disconnect',
      subscriptionDisconnecting: 'Disconnecting…',
      subscriptionSigningIn: 'Signing in',
      loginChatGPT: 'Sign in with ChatGPT',
      loginGrok: 'Sign in with SuperGrok or X Premium',
      subscriptionLoginDescription: 'Open the verification page, enter this one-time code, and return here.',
      subscriptionOpenVerification: 'Open verification page',
      subscriptionCode: 'One-time code:',
      subscriptionWaiting: 'Waiting for authorization…',
      subscriptionSucceeded: 'Subscription connected.',
      subscriptionCancelled: 'Sign-in cancelled.',
      subscriptionCancel: 'Cancel sign-in',
      exaTitle: 'Exa API key',
      exaIntro: 'Exa is a dedicated search endpoint. Store its API key here; it is used only for search.',
      exaKeyPlaceholder: 'Enter Exa API key',
      exaKeySaving: 'Saving…',
      exaKeySave: 'Save',
      exaKeyUpdate: 'Update key',
      loading: 'Loading search provider status…',
      loadFailed: 'Failed to load search provider status.',
      saveFailed: 'Failed to save key.',
      disconnectFailed: 'Disconnect failed.',
      signInFailed: 'Sign-in failed.',
    }

    const zh = {
      nav: '搜索',
      title: '网页搜索',
      intro: '配置搜索提供方及其回退顺序。',
      chainTitle: '搜索链',
      chainIntro: '按顺序尝试提供方。不可用的提供方会被跳过；首个成功的结果即返回。',
      providerHeader: '提供方',
      statusHeader: '状态',
      statusAvailable: '可用',
      statusUnavailable: '不可用',
      providerChatGPT: 'ChatGPT Plus/Pro',
      providerGrok: 'Grok / X 订阅',
      providerExa: 'Exa',
      providerDeepSeek: 'DeepSeek',
      subscriptionsTitle: '订阅搜索',
      subscriptionsIntro: '使用你的 ChatGPT 或 Grok 订阅进行搜索。OAuth 凭据只保存在这台电脑的 DSH 中。',
      subscriptionConnected: '已连接',
      subscriptionDisconnected: '未连接',
      subscriptionConnecting: '正在启动登录…',
      subscriptionDisconnect: '断开连接',
      subscriptionDisconnecting: '正在断开…',
      subscriptionSigningIn: '正在登录',
      loginChatGPT: '使用 ChatGPT 登录',
      loginGrok: '使用 SuperGrok 或 X Premium 登录',
      subscriptionLoginDescription: '打开验证页面，输入此一次性代码，然后返回此处。',
      subscriptionOpenVerification: '打开验证页面',
      subscriptionCode: '一次性代码：',
      subscriptionWaiting: '等待授权…',
      subscriptionSucceeded: '订阅已连接。',
      subscriptionCancelled: '登录已取消。',
      subscriptionCancel: '取消登录',
      exaTitle: 'Exa API 密钥',
      exaIntro: 'Exa 是专用搜索端点。在此存储其 API 密钥；该密钥仅用于搜索。',
      exaKeyPlaceholder: '输入 Exa API 密钥',
      exaKeySaving: '保存中…',
      exaKeySave: '保存',
      exaKeyUpdate: '更新密钥',
      loading: '正在加载搜索提供方状态…',
      loadFailed: '加载搜索提供方状态失败。',
      saveFailed: '保存密钥失败。',
      disconnectFailed: '断开连接失败。',
      signInFailed: '登录失败。',
    }

    const PROVIDERS = [
      { id: 'openai-codex', nameKey: 'providerChatGPT', loginKey: 'loginChatGPT', kind: 'subscription' },
      { id: 'xai', nameKey: 'providerGrok', loginKey: 'loginGrok', kind: 'subscription' },
      { id: 'exa', nameKey: 'providerExa', kind: 'apiKey', ref: 'EXA_API_KEY' },
      { id: 'deepseek-official', nameKey: 'providerDeepSeek', kind: 'shared', ref: 'DEEPSEEK_API_KEY' },
    ]

    function fallbackT(key) {
      return zh[key] ?? key
    }

    function useT(locale) {
      if (locale !== undefined && typeof locale.subscribe === 'function' && typeof locale.bind === 'function') {
        React.useSyncExternalStore(locale.subscribe, () => locale.getSnapshot().revision, () => locale.getSnapshot().revision)
        return locale.bind(NS)
      }
      return fallbackT
    }

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
      const t = useT(props.locale)
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
                  return { ...provider, configured: auth?.configured === true }
                }
                return { ...provider, configured: credentials[provider.ref]?.configured === true }
              }),
              exaConfigured: credentials.EXA_API_KEY?.configured === true,
            })
          } catch (cause) {
            store.update({ status: 'load-failed', error: cause instanceof Error ? cause.message : t('loadFailed') })
          }
        })()
      }, [state.status, props.connection, store])

      if (state.status === 'idle' || state.status === 'loading') {
        return h('p', null, t('loading'))
      }
      if (state.status === 'load-failed') {
        return h('p', { style: errorStyle }, state.error ?? t('loadFailed'))
      }

      const subscription = state.providers.filter(p => p.kind === 'subscription')
      return h('div', { style: sectionStyle },
        h('h2', null, t('title')),
        h('p', { style: secondaryStyle }, t('intro')),
        h('h3', null, t('chainTitle')),
        h('p', { style: secondaryStyle }, t('chainIntro')),
        h('table', { style: tableStyle },
          h('thead', null, h('tr', null,
            h('th', { style: thStyle }, t('providerHeader')),
            h('th', { style: thStyle }, t('statusHeader')),
          )),
          h('tbody', null,
            ...state.providers.map((provider, index) => h('tr', { key: provider.id },
              h('td', { style: tdStyle }, `${index + 1}. ${t(provider.nameKey)}`),
              h('td', { style: tdStyle }, provider.configured ? t('statusAvailable') : t('statusUnavailable')),
            )),
          ),
        ),
        h('h3', null, t('subscriptionsTitle')),
        h('p', { style: secondaryStyle }, t('subscriptionsIntro')),
        ...subscription.map(provider => h(SubscriptionCard, {
          key: provider.id,
          provider,
          state,
          store,
          connection: props.connection,
          t,
        })),
        h('h3', null, t('exaTitle')),
        h('p', { style: secondaryStyle }, t('exaIntro')),
        h('div', { style: rowStyle },
          h('input', {
            type: 'password',
            autoComplete: 'off',
            value: exaDraft,
            placeholder: t('exaKeyPlaceholder'),
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
                store.update({ error: cause instanceof Error ? cause.message : t('saveFailed') })
              } finally {
                setSaving(false)
              }
            },
          }, saving ? t('exaKeySaving') : state.exaConfigured ? t('exaKeyUpdate') : t('exaKeySave')),
        ),
        state.error !== null ? h('p', { style: errorStyle }, state.error) : null,
      )
    }

    function SubscriptionCard(props) {
      const { provider, state, store, connection, t } = props
      const busy = state.busyProvider === provider.id
      const visible = state.login?.challenge.provider === provider.id ? state.login : null

      if (provider.configured) {
        return h('div', { style: cardStyle },
          h('div', { style: rowStyle },
            h('span', null, t(provider.nameKey)),
            h('span', { style: badgeStyle }, t('subscriptionConnected')),
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
                store.update({ error: cause instanceof Error ? cause.message : t('disconnectFailed') })
              } finally {
                store.update({ busyProvider: null })
              }
            },
          }, busy ? t('subscriptionDisconnecting') : t('subscriptionDisconnect')),
        )
      }

      if (visible === null) {
        return h('div', { style: cardStyle },
          h('div', { style: rowStyle },
            h('span', null, t(provider.nameKey)),
            h('span', { style: mutedBadgeStyle }, t('subscriptionDisconnected')),
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
                store.update({ error: cause instanceof Error ? cause.message : t('signInFailed') })
              } finally {
                store.update({ busyProvider: null })
              }
            },
          }, busy ? t('subscriptionConnecting') : t(provider.loginKey)),
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
          h('span', null, t(provider.nameKey)),
          h('span', { style: mutedBadgeStyle }, t('subscriptionSigningIn')),
        ),
        status.kind === 'succeeded'
          ? h('p', null, t('subscriptionSucceeded'))
          : status.kind === 'cancelled'
            ? h('p', null, t('subscriptionCancelled'))
            : h('div', null,
                h('p', null, t('subscriptionLoginDescription')),
                h('a', {
                  href: challenge.verificationUri,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                }, t('subscriptionOpenVerification')),
                h('div', { style: rowStyle },
                  h('span', null, t('subscriptionCode')),
                  h('code', null, challenge.userCode),
                ),
                h('p', null, status.kind === 'pending' ? t('subscriptionWaiting') : ''),
              ),
        status.kind === 'pending'
          ? h('button', {
              type: 'button',
              onClick: async () => {
                const result = await connection.rpc.call(CHANNEL, 'cancel-login', { loginId: challenge.loginId })
                if (result.ok) store.update({ login: { ...visible, status: { kind: 'cancelled', provider: provider.id } } })
              },
            }, t('subscriptionCancel'))
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

    function readLocale(ctx) {
      try {
        return ctx.locale
      } catch {
        return undefined
      }
    }

    function registerCopy(locale) {
      try {
        return locale.register(NS, { zh, en })
      } catch (error) {
        if (!String(error?.message ?? error).includes('already has locale')) throw error
        return () => {}
      }
    }

    function apply(ctx) {
      const store = createStore()
      const locale = readLocale(ctx)
      if (locale !== undefined && typeof locale.register === 'function') {
        if (typeof ctx.effect === 'function') ctx.effect(() => registerCopy(locale), 'dsh-subscription-search: copy dictionaries')
        else registerCopy(locale)
      }
      const t = locale !== undefined && typeof locale.bind === 'function' ? locale.bind(NS) : fallbackT
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'search',
        order: 12,
        label: () => t('nav'),
        inject: () => ({ store, connection: ctx.connection, locale }),
      }, (props) => h(Section, { ...props, store, connection: ctx.connection, locale })))
    }

    return { apply, inject }
  },
})
