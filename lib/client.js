window.__ModuleLoader__.load({
  id: 'dsh-subscription-search',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const CHANNEL = '/subscription-search'
    const NS = 'dsh-subscription-search'

    const en = {
      nav: 'Search', title: 'Web Search', intro: 'Manage the ordered search chain, runtime status, and bounded diagnostics.',
      accounts: 'Credentials and subscription accounts are managed in Accounts & Usage.', chain: 'Search chain',
      provider: 'Provider', status: 'Status', enabled: 'Enabled', registered: 'Registered', unregistered: 'Not registered',
      available: 'Available', unavailable: 'Unavailable', unknown: 'Unknown', up: 'Move up', down: 'Move down',
      perLeg: 'Per-backend timeout (ms)', total: 'Total timeout (ms)', save: 'Save chain', saving: 'Saving…',
      diagnostics: 'Recent diagnostics', noDiagnostics: 'No searches recorded yet.', outcome: 'Outcome', attempts: 'Attempts',
      loading: 'Loading search chain…', failed: 'Could not load search chain.', saved: 'Search chain saved.',
    }
    const zh = {
      nav: '搜索', title: '网页搜索', intro: '管理有序搜索链、运行状态与有界诊断。',
      accounts: '凭据和订阅账户请前往“账户与用量”管理。', chain: '搜索链', provider: '提供方', status: '状态',
      enabled: '启用', registered: '已注册', unregistered: '未注册', available: '可用', unavailable: '不可用', unknown: '未知',
      up: '上移', down: '下移', perLeg: '单后端超时（毫秒）', total: '总超时（毫秒）', save: '保存搜索链', saving: '保存中…',
      diagnostics: '最近诊断', noDiagnostics: '尚无搜索记录。', outcome: '结果', attempts: '尝试', loading: '正在加载搜索链…',
      failed: '无法加载搜索链。', saved: '搜索链已保存。',
    }

    function interpolate(template, params) {
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match)
    }
    function fallbackT(key, params) { return interpolate(zh[key] ?? key, params) }
    function useT(locale) {
      if (locale && typeof locale.subscribe === 'function' && typeof locale.bind === 'function') {
        React.useSyncExternalStore(locale.subscribe, () => locale.getSnapshot().revision, () => locale.getSnapshot().revision)
        return locale.bind(NS)
      }
      return fallbackT
    }
    function readLocale(ctx) { try { return ctx.locale } catch { return undefined } }
    function registerCopy(locale) {
      try { return locale.register(NS, { zh, en }) }
      catch (error) { if (!String(error?.message ?? error).includes('already has locale')) throw error; return () => {} }
    }

    function availability(entry, t) {
      if (!entry.registered) return t('unregistered')
      if (entry.availability === 'available') return t('available')
      if (entry.availability === 'unavailable') return t('unavailable')
      return t('unknown')
    }

    /** Status color follows the host theme aliases; fixed hues stay legible in both modes. */
    function availabilityStyle(entry) {
      if (!entry.registered) return { ...badgeStyle, color: C.textTertiary }
      if (entry.availability === 'available') return { ...badgeStyle, color: C.success }
      if (entry.availability === 'unavailable') return { ...badgeStyle, color: C.error }
      return { ...badgeStyle, color: C.textTertiary }
    }

    function Section({ connection, locale }) {
      const t = useT(locale)
      const [status, setStatus] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [message, setMessage] = React.useState(null)
      const [saving, setSaving] = React.useState(false)

      React.useEffect(() => {
        let live = true
        void connection.rpc.call(CHANNEL, 'status', {}).then(response => {
          if (!live) return
          if (!response.ok) throw new Error(response.error.message)
          setStatus(response.value)
          setDraft(response.value.settings)
        }).catch(() => { if (live) setMessage(t('failed')) })
        return () => { live = false }
      }, [connection])

      if (status === null || draft === null) return h('p', null, message ?? t('loading'))
      const byId = new Map(status.backends.map(entry => [entry.id, entry]))
      const updateOrder = (index, delta) => {
        const order = [...draft.order]
        const other = index + delta
        if (other < 0 || other >= order.length) return
        ;[order[index], order[other]] = [order[other], order[index]]
        setDraft({ ...draft, order })
      }
      const rows = draft.order.map((id, index) => {
        const entry = byId.get(id) ?? { id, label: id, registered: false, availability: 'unregistered' }
        return h('tr', { key: id },
          h('td', { style: cell }, h('input', {
            type: 'checkbox', style: checkbox, checked: draft.enabled[id] !== false,
            onChange: event => setDraft({ ...draft, enabled: { ...draft.enabled, [id]: event.target.checked } }),
          })),
          h('td', { style: cell }, `${index + 1}. ${entry.label}`),
          h('td', { style: cell }, h('span', { style: availabilityStyle(entry) }, availability(entry, t))),
          h('td', { style: cell },
            h('button', { type: 'button', style: { ...buttonStyle, padding: '3px 10px', fontSize: 12 }, disabled: index === 0, onClick: () => updateOrder(index, -1) }, t('up')),
            ' ', h('button', { type: 'button', style: { ...buttonStyle, padding: '3px 10px', fontSize: 12 }, disabled: index === draft.order.length - 1, onClick: () => updateOrder(index, 1) }, t('down')),
          ),
        )
      })
      return h('div', { style: section },
        h('h2', null, t('title')), h('p', { style: secondary }, t('intro')),
        h('p', { style: accountNotice }, t('accounts')),
        h('h3', null, t('chain')),
        h('table', { style: table }, h('thead', null, h('tr', null,
          h('th', { style: headCell }, t('enabled')), h('th', { style: headCell },
            t('provider')),
          h('th', { style: headCell }, t('status')), h('th', { style: headCell }),
        )), h('tbody', null, ...rows)),
        h('div', { style: fieldRow },
          h('label', { style: field }, t('perLeg'), h('input', { type: 'number', min: 1, max: 300000, value: draft.perLegTimeoutMs, style: numberInput,
            onChange: event => setDraft({ ...draft, perLegTimeoutMs: Number(event.target.value) }) })),
          h('label', { style: field }, t('total'), h('input', { type: 'number', min: 1, max: 300000, value: draft.totalTimeoutMs, style: numberInput,
            onChange: event => setDraft({ ...draft, totalTimeoutMs: Number(event.target.value) }) })),
        ),
        h('div', { style: actionRow },
          h('button', { type: 'button', style: saving ? disabledButton : primaryButton, disabled: saving, onClick: async () => {
            setSaving(true); setMessage(null)
            try {
              const response = await connection.rpc.call(CHANNEL, 'update-settings', { settings: draft })
              if (!response.ok) throw new Error(response.error.message)
              setStatus(response.value); setDraft(response.value.settings); setMessage(t('saved'))
            } catch { setMessage(t('failed')) } finally { setSaving(false) }
          } }, saving ? t('saving') : t('save')),
          message ? h('span', { style: secondary }, message) : null,
        ),
        h('h3', null, t('diagnostics')),
        status.diagnostics.length === 0 ? h('p', { style: secondary }, t('noDiagnostics')) : h('table', { style: table },
          h('thead', null, h('tr', null, h('th', { style: headCell }, t('outcome')), h('th', { style: headCell }, t('attempts')))),
          h('tbody', null, ...status.diagnostics.slice().reverse().map((entry, index) => h('tr', { key: `${entry.startedAt}-${index}` },
            h('td', { style: cell }, entry.outcome),
            h('td', { style: cell }, entry.attempts.map(attempt => `${attempt.id}:${attempt.status}`).join(' → ')),
          ))),
        ),
      )
    }

    /**
     * Theme tokens follow the host's `--dsw-alias-*` seam (the same family the
     * Accounts & Usage panel rides), which the host redefines per light/dark
     * mode. Fallback literals only render when a future host drops an alias.
     */
    const C = {
      text: 'var(--dsw-alias-label-primary, #0f1115)',
      textSecondary: 'var(--dsw-alias-label-secondary, #61666b)',
      textTertiary: 'var(--dsw-alias-label-tertiary, #8f949e)',
      bgBase: 'var(--dsw-alias-bg-base, transparent)',
      bgMuted: 'var(--dsw-alias-bg-multi-select, rgba(127, 127, 127, 0.08))',
      border: 'var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.22))',
      borderFaint: 'var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.12))',
      brandFill: 'var(--dsw-alias-button-primary-fill, #0f1115)',
      brandText: 'var(--dsw-alias-label-primary-foreground, #fff)',
      accent: 'var(--dsw-alias-state-business-primary, #4176e6)',
      success: 'var(--dsw-alias-state-success-primary, #16a34a)',
      error: 'var(--dsw-alias-state-error-primary, #dc2626)',
    }
    const section = { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 760 }
    const secondary = { margin: 0, color: C.textSecondary, fontSize: 13 }
    const accountNotice = {
      padding: '10px 12px', borderRadius: 8, fontSize: 13, margin: 0,
      color: C.textSecondary, background: C.bgMuted, border: `1px solid ${C.borderFaint}`,
    }
    const table = { width: '100%', borderCollapse: 'collapse', fontSize: 13 }
    const headCell = {
      textAlign: 'left', padding: '6px 12px 6px 0', borderBottom: `1px solid ${C.border}`,
      fontSize: 12, color: C.textSecondary, fontWeight: 500,
    }
    const cell = { textAlign: 'left', padding: '7px 12px 7px 0', borderBottom: `1px solid ${C.borderFaint}` }
    const badgeStyle = { fontSize: 12, fontWeight: 500 }
    const buttonStyle = {
      padding: '6px 12px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
      border: `1px solid ${C.border}`, background: C.bgBase, color: C.text,
    }
    const primaryButton = {
      padding: '6px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
      border: '1px solid transparent', background: C.brandFill, color: C.brandText,
    }
    const disabledButton = { ...primaryButton, opacity: 0.55, cursor: 'default' }
    const fieldRow = { display: 'flex', gap: 24, flexWrap: 'wrap' }
    const field = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: C.textSecondary }
    const numberInput = {
      display: 'block', width: 180, padding: '6px 10px', borderRadius: 8, fontSize: 13,
      border: `1px solid ${C.border}`, background: C.bgBase, color: C.text,
    }
    const checkbox = { accentColor: C.accent, cursor: 'pointer' }
    const actionRow = { display: 'flex', alignItems: 'center', gap: 12 }
    const inject = ['slots', 'connection']

    function apply(ctx) {
      const locale = readLocale(ctx)
      if (locale && typeof locale.register === 'function') {
        if (typeof ctx.effect === 'function') ctx.effect(() => registerCopy(locale), 'dsh-subscription-search: copy dictionaries')
        else registerCopy(locale)
      }
      const t = locale && typeof locale.bind === 'function' ? locale.bind(NS) : fallbackT
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'search', order: 12, label: () => t('nav'),
        inject: () => ({ connection: ctx.connection, locale }),
      }, props => h(Section, { ...props, connection: ctx.connection, locale })))
    }

    return { apply, inject }
  },
})
