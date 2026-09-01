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

    const STYLE_ID = 'dsh-subscription-search'
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-subscription-search'
      style.dataset.pluginCss = STYLE_ID
      style.textContent = `
.dss-section { display: flex; flex-direction: column; gap: 16px; max-width: 760px; color: var(--dsw-alias-label-primary, #f9fafb); }
.dss-title { margin: 0 0 4px; font-size: 20px; line-height: 28px; font-weight: 600; color: var(--dsw-alias-label-primary, #f9fafb); }
.dss-secondary { margin: 0; color: var(--dsw-alias-label-tertiary, #adb2b8); font-size: 13px; line-height: 20px; }
.dss-account-notice { padding: 12px 16px; border-radius: 8px; background: var(--dsw-alias-bg-layer-3, rgba(255, 255, 255, 0.05)); border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08)); font-size: 13px; color: var(--dsw-alias-label-secondary, #cfd3d6); }
.dss-h3 { margin: 12px 0 0; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary, #f9fafb); }
.dss-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 4px; }
.dss-th { text-align: left; padding: 8px 12px; color: var(--dsw-alias-label-tertiary, #adb2b8); font-weight: 500; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.12)); }
.dss-td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.06)); color: var(--dsw-alias-label-primary, #f9fafb); vertical-align: middle; }
.dss-checkbox { cursor: pointer; accent-color: var(--dsw-static-deepseek-500, #4176e6); width: 15px; height: 15px; }
.dss-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 500; }
.dss-badge-available { background: var(--dsw-alias-state-success-tertiary, rgba(34, 197, 94, 0.15)); color: var(--dsw-alias-state-success-primary, #22c55e); }
.dss-badge-unavailable { background: var(--dsw-alias-interactive-bg-hover-danger, rgba(242, 90, 90, 0.15)); color: var(--dsw-alias-state-error-primary, #f25a5a); }
.dss-badge-unknown { background: var(--dsw-alias-bg-layer-3, rgba(255, 255, 255, 0.08)); color: var(--dsw-alias-label-tertiary, #adb2b8); }
.dss-badge-unregistered { background: var(--dsw-alias-bg-layer-3, rgba(255, 255, 255, 0.05)); color: var(--dsw-alias-label-caption, #81858c); }
.dss-btn-group { display: inline-flex; gap: 6px; }
.dss-btn { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.15)); background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.04)); color: var(--dsw-alias-label-primary, #f9fafb); font: inherit; font-size: 12px; cursor: pointer; transition: all var(--ds-transition-duration, 0.2s); }
.dss-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.1)); border-color: var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.25)); }
.dss-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.dss-btn-primary { background: var(--dsw-static-deepseek-500, #4176e6); color: #ffffff; border: 1px solid transparent; font-weight: 500; padding: 6px 16px; border-radius: 6px; }
.dss-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-info-hover, #3461c7); }
.dss-form-row { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
.dss-label { font-size: 13px; color: var(--dsw-alias-label-secondary, #cfd3d6); font-weight: 500; }
.dss-input { box-sizing: border-box; width: 220px; padding: 7px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.15)); background: var(--dsw-alias-bg-layer-1, #1b1b1c); color: var(--dsw-alias-label-primary, #f9fafb); font: inherit; font-size: 13px; outline: none; transition: border-color var(--ds-transition-duration, 0.2s); }
.dss-input:focus { border-color: var(--dsw-static-deepseek-500, #4176e6); }
.dss-diag-row { font-family: var(--ds-font-family-code, monospace); font-size: 12px; }
`
      document.head.appendChild(style)
    }

    function availabilityBadge(entry, t) {
      if (!entry.registered) return h('span', { className: 'dss-badge dss-badge-unregistered' }, t('unregistered'))
      if (entry.availability === 'available') return h('span', { className: 'dss-badge dss-badge-available' }, t('available'))
      if (entry.availability === 'unavailable') return h('span', { className: 'dss-badge dss-badge-unavailable' }, t('unavailable'))
      return h('span', { className: 'dss-badge dss-badge-unknown' }, t('unknown'))
    }

    function Section({ connection, locale }) {
      ensureStyles()
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

      if (status === null || draft === null) return h('p', { className: 'dss-secondary' }, message ?? t('loading'))
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
          h('td', { className: 'dss-td' }, h('input', {
            type: 'checkbox', className: 'dss-checkbox', checked: draft.enabled[id] !== false,
            onChange: event => setDraft({ ...draft, enabled: { ...draft.enabled, [id]: event.target.checked } }),
          })),
          h('td', { className: 'dss-td' }, `${index + 1}. ${entry.label}`),
          h('td', { className: 'dss-td' }, availabilityBadge(entry, t)),
          h('td', { className: 'dss-td' },
            h('div', { className: 'dss-btn-group' },
              h('button', { type: 'button', className: 'dss-btn', disabled: index === 0, onClick: () => updateOrder(index, -1) }, t('up')),
              h('button', { type: 'button', className: 'dss-btn', disabled: index === draft.order.length - 1, onClick: () => updateOrder(index, 1) }, t('down')),
            ),
          ),
        )
      })
      return h('div', { className: 'dss-section' },
        h('div', null,
          h('h2', { className: 'dss-title' }, t('title')),
          h('p', { className: 'dss-secondary' }, t('intro')),
        ),
        h('div', { className: 'dss-account-notice' }, t('accounts')),
        h('h3', { className: 'dss-h3' }, t('chain')),
        h('table', { className: 'dss-table' }, h('thead', null, h('tr', null,
          h('th', { className: 'dss-th', style: { width: 44 } }, t('enabled')),
          h('th', { className: 'dss-th' }, t('provider')),
          h('th', { className: 'dss-th', style: { width: 100 } }, t('status')),
          h('th', { className: 'dss-th', style: { width: 140 } }),
        )), h('tbody', null, ...rows)),
        h('div', { className: 'dss-form-row' },
          h('label', { className: 'dss-label' }, t('perLeg')),
          h('input', { type: 'number', min: 1, max: 300000, value: draft.perLegTimeoutMs, className: 'dss-input',
            onChange: event => setDraft({ ...draft, perLegTimeoutMs: Number(event.target.value) }) }),
        ),
        h('div', { className: 'dss-form-row' },
          h('label', { className: 'dss-label' }, t('total')),
          h('input', { type: 'number', min: 1, max: 300000, value: draft.totalTimeoutMs, className: 'dss-input',
            onChange: event => setDraft({ ...draft, totalTimeoutMs: Number(event.target.value) }) }),
        ),
        h('div', { style: { marginTop: 4 } },
          h('button', { type: 'button', className: 'dss-btn dss-btn-primary', disabled: saving, onClick: async () => {
            setSaving(true); setMessage(null)
            try {
              const response = await connection.rpc.call(CHANNEL, 'update-settings', { settings: draft })
              if (!response.ok) throw new Error(response.error.message)
              setStatus(response.value); setDraft(response.value.settings); setMessage(t('saved'))
            } catch { setMessage(t('failed')) } finally { setSaving(false) }
          } }, saving ? t('saving') : t('save')),
        ),
        message ? h('p', { className: 'dss-secondary' }, message) : null,
        h('h3', { className: 'dss-h3' }, t('diagnostics')),
        status.diagnostics.length === 0 ? h('p', { className: 'dss-secondary' }, t('noDiagnostics')) : h('table', { className: 'dss-table' },
          h('thead', null, h('tr', null,
            h('th', { className: 'dss-th', style: { width: 120 } }, t('outcome')),
            h('th', { className: 'dss-th' }, t('attempts')),
          )),
          h('tbody', null, ...status.diagnostics.slice().reverse().map((entry, index) => h('tr', { key: `${entry.startedAt}-${index}`, className: 'dss-diag-row' },
            h('td', { className: 'dss-td' }, entry.outcome),
            h('td', { className: 'dss-td' }, entry.attempts.map(attempt => `${attempt.id}:${attempt.status}`).join(' → ')),
          ))),
        ),
      )
    }

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
