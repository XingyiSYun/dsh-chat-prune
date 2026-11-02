window.__ModuleLoader__.load({
  id: 'dsh-chat-prune',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Host route that removes one turn; resolved against the page base. */
    const PRUNE_PATH = 'chat-prune/prune'
    /** Host route that reports whether one turn is already hidden. */
    const STATE_PATH = 'chat-prune/turn'

    const TEXT = {
      en: {
        action: 'Remove from context',
        hint: 'The AI will no longer see this turn; the transcript keeps the original text.',
        confirm: 'Hide this turn from the AI?',
        confirmYes: 'Remove',
        cancel: 'Cancel',
        busy: 'Removing…',
        removed: 'Removed from context',
        'err.session-not-live': 'This session is not loaded. Reopen it and retry.',
        'err.turn-open': 'This turn is still running.',
        'err.already-pruned': 'This turn is already hidden from the AI.',
        'err.no-turn': 'There is no turn to remove here.',
        'err.missing-session': 'This action has no session to work on.',
        'err.default': 'The turn could not be removed.',
      },
      zh: {
        action: '从上下文删除',
        hint: 'AI 之后不会再看到这一轮；聊天记录里仍保留原话。',
        confirm: '不再让 AI 看到这一轮？',
        confirmYes: '删除',
        cancel: '取消',
        busy: '删除中…',
        removed: '已从上下文删除',
        'err.session-not-live': '会话未加载，请重新打开后再试。',
        'err.turn-open': '本轮还在运行，结束之后再删。',
        'err.already-pruned': '这一轮已经不给 AI 看了。',
        'err.no-turn': '这里没有可以删除的一轮。',
        'err.missing-session': '这个操作没有可用的会话。',
        'err.default': '这一轮没能删除。',
      },
    }

    /**
     * Read the active locale id, following live changes.
     *
     * The locale service is the authority; the document language and the
     * browser language are fallbacks for a Client context that does not expose
     * the service to this module.
     * @param locale - the Client locale service, when present.
     * @returns the locale id, for example `zh-CN`.
     */
    function useLocaleId(locale) {
      const read = () => {
        const candidates = []
        try {
          const snapshot = locale?.getLocale?.() ?? locale?.getSnapshot?.()
          candidates.push(snapshot?.id, snapshot?.locale)
        } catch {
          /* the service is optional */
        }
        try {
          candidates.push(document.documentElement.lang)
        } catch {
          /* not in a document */
        }
        try {
          candidates.push(navigator.language)
        } catch {
          /* not in a browser */
        }
        for (const candidate of candidates) {
          if (typeof candidate === 'string' && candidate !== '') return candidate
        }
        return ''
      }
      const [id, setId] = React.useState(read)
      React.useEffect(() => {
        if (typeof locale?.subscribe !== 'function') return undefined
        const off = locale.subscribe(() => setId(read()))
        return typeof off === 'function' ? off : undefined
      }, [])
      return id
    }

    /**
     * Build the translate function for one locale id.
     * @param localeId - the active locale id.
     * @returns a lookup that falls back to English.
     */
    function translate(localeId) {
      const dict = String(localeId).toLowerCase().startsWith('zh') ? TEXT.zh : TEXT.en
      return (key) => dict[key] ?? TEXT.en[key] ?? key
    }

    /**
     * Post one JSON body to a Host route of this plugin.
     * @param path - the route, relative to the page base.
     * @param payload - the JSON body.
     * @returns the Host answer.
     */
    async function postJson(path, payload) {
      const base = typeof document === 'undefined' ? 'http://localhost/' : document.baseURI
      const response = await fetch(new URL(path, base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await response.json().catch(() => undefined)
      if (body === undefined || typeof body !== 'object') throw new Error('bad-response')
      return body
    }

    /**
     * Ask the Host to hide one turn from the model.
     * @param sessionId - the viewed session.
     * @param seq - a sequence inside the turn.
     * @returns the Host answer.
     */
    function requestPrune(sessionId, seq) {
      return postJson(PRUNE_PATH, { sessionId, seq })
    }

    /**
     * Ask the Host whether one turn is already hidden. Read-only: a probe can
     * never change the session.
     * @param sessionId - the viewed session.
     * @param seq - a sequence inside the turn.
     * @returns the Host answer.
     */
    async function requestState(sessionId, seq) {
      const base = typeof document === 'undefined' ? 'http://localhost/' : document.baseURI
      const url = new URL(STATE_PATH, base)
      url.searchParams.set('sessionId', sessionId)
      url.searchParams.set('seq', String(seq))
      const response = await fetch(url)
      const body = await response.json().catch(() => undefined)
      if (body === undefined || typeof body !== 'object') throw new Error('bad-response')
      return body
    }

    /** Shared button box, reusing the host's control radius and font. */
    const baseButton = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      height: 24,
      padding: '0 7px',
      margin: 0,
      border: '1px solid transparent',
      borderRadius: 6,
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      font: 'inherit',
      fontSize: 12,
      lineHeight: 1,
      whiteSpace: 'nowrap',
      cursor: 'pointer',
    }

    /**
     * One "delete this turn" control in a completed turn's footer.
     * @param props - slot props carrying the session id and the turn's closing sequence.
     * @returns the rendered control.
     */
    function DeleteTurnAction(props) {
      const localeId = useLocaleId(props.localeService)
      const t = translate(localeId)
      const [phase, setPhase] = React.useState('idle')
      const [hidden, setHidden] = React.useState(false)
      const [error, setError] = React.useState('')
      const [hover, setHover] = React.useState('')

      const sessionId = props.sessionId
      const seq = props.seq

      React.useEffect(() => {
        if (typeof props.sessionId !== 'string' || props.sessionId === '') return undefined
        let alive = true
        requestState(props.sessionId, props.seq)
          .then((answer) => {
            if (alive && answer.ok === true && answer.pruned === true) setHidden(true)
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [props.sessionId, props.seq])

      if (typeof sessionId !== 'string' || sessionId === '') return null

      const submit = async () => {
        setPhase('busy')
        setError('')
        try {
          const result = await requestPrune(sessionId, seq)
          if (result.ok !== true) {
            const key = `err.${String(result.error ?? 'default')}`
            const localized = t(key)
            const detail = typeof result.message === 'string' ? result.message : ''
            setError(localized === key ? detail || t('err.default') : localized)
            setPhase('idle')
            return
          }
          setHidden(true)
          setPhase('idle')
        } catch (failure) {
          setError(String(failure?.message ?? failure))
          setPhase('idle')
        }
      }

      const row = { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }

      if (hidden) {
        return h(
          'span',
          {
            title: t('hint'),
            style: { ...row, gap: 4, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
          },
          eyeOffIcon(),
          h('span', null, t('removed')),
        )
      }

      if (phase === 'confirm') {
        return h(
          'span',
          { style: row },
          h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, t('confirm')),
          h(
            'button',
            {
              type: 'button',
              style: {
                ...baseButton,
                color: 'var(--dsw-alias-state-error-primary)',
                borderColor: 'var(--dsw-alias-state-error-primary)',
                background: hover === 'yes' ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
              },
              onMouseEnter: () => setHover('yes'),
              onMouseLeave: () => setHover(''),
              onClick: submit,
            },
            t('confirmYes'),
          ),
          h(
            'button',
            {
              type: 'button',
              style: {
                ...baseButton,
                background: hover === 'no' ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
              },
              onMouseEnter: () => setHover('no'),
              onMouseLeave: () => setHover(''),
              onClick: () => {
                setPhase('idle')
                setError('')
              },
            },
            t('cancel'),
          ),
        )
      }

      const busy = phase === 'busy'
      return h(
        'span',
        { style: row },
        h(
          'button',
          {
            type: 'button',
            title: t('hint'),
            'aria-label': t('hint'),
            disabled: busy,
            style: {
              ...baseButton,
              background: hover === 'action' && !busy ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
              color: hover === 'action' && !busy ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
              opacity: busy ? 0.6 : 1,
              cursor: busy ? 'default' : 'pointer',
            },
            onMouseEnter: () => setHover('action'),
            onMouseLeave: () => setHover(''),
            onClick: () => setPhase('confirm'),
          },
          trashIcon(),
          busy ? t('busy') : t('action'),
        ),
        error === ''
          ? null
          : h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' } }, error),
      )
    }

    /**
     * Small trash glyph for the action label.
     * @returns the icon element.
     */
    function trashIcon() {
      return h(
        'svg',
        {
          width: 12,
          height: 12,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M3 4.5h10' }),
        h('path', { d: 'M6.5 4.5V3h3v1.5' }),
        h('path', { d: 'M4.5 4.5l.6 7.4a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-7.4' }),
        h('path', { d: 'M6.8 7v3.4M9.2 7v3.4' }),
      )
    }

    /**
     * Small "hidden" glyph: an eye with a slash.
     * @returns the icon element.
     */
    function eyeOffIcon() {
      return h(
        'svg',
        {
          width: 12,
          height: 12,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M2 8s2.2-3.6 6-3.6S14 8 14 8s-2.2 3.6-6 3.6S2 8 2 8z' }),
        h('circle', { cx: 8, cy: 8, r: 1.7 }),
        h('path', { d: 'M3 13 13 3' }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = ctx.get('locale')
        ctx.slots.inject('conversation.chat.turnTail', () =>
          ctx.slots.register(
            { name: 'conversation.chat.turnTail', id: 'chat-prune', order: 20 },
            (props) => h(DeleteTurnAction, { ...props, localeService: locale }),
          ),
        )
      },
    }
  },
})
