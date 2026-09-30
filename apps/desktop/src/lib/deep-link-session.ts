/**
 * Parse hermes://session/* deep-link payloads into structured actions.
 *
 * URL shapes (hostname = kind, pathname = name):
 *   hermes://session/new?title=…&cwd=…&prompt=…&listed=0|1
 *   hermes://session/open/<storedSessionId>
 *   hermes://session/open?id=<storedSessionId>
 *
 * `prompt` is draft composer text only — never auto-submit.
 */

export type DeepLinkSessionPayload = {
  kind: string
  name: string
  params: Record<string, string>
}

export type DeepLinkSessionNew = {
  action: 'new'
  /** Sidebar visibility after create. Default true for external openers. */
  listed: boolean
  title?: string
  cwd?: string
  /** Draft text for the new session composer (not auto-sent). */
  prompt?: string
}

export type DeepLinkSessionOpen = {
  action: 'open'
  storedSessionId: string
}

export type DeepLinkSessionAction = DeepLinkSessionNew | DeepLinkSessionOpen

function truthyParam(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw === '') {
    return defaultValue
  }

  const v = raw.trim().toLowerCase()

  if (['0', 'false', 'no', 'off'].includes(v)) {
    return false
  }

  if (['1', 'true', 'yes', 'on'].includes(v)) {
    return true
  }

  return defaultValue
}

/**
 * Interpret a deep-link payload. Returns null for non-session kinds or
 * malformed session links (caller should ignore).
 */
export function parseDeepLinkSessionAction(
  payload: DeepLinkSessionPayload | null | undefined
): DeepLinkSessionAction | null {
  if (!payload || payload.kind !== 'session') {
    return null
  }

  const name = (payload.name || '').trim()
  const params = payload.params || {}

  if (!name) {
    return null
  }

  // hermes://session/new?...
  if (name === 'new' || name.startsWith('new/')) {
    const title = (params.title || params.name || '').trim() || undefined
    const cwd = (params.cwd || params.workdir || params.path || '').trim() || undefined
    const prompt = (params.prompt || params.text || params.q || '').trim() || undefined
    const listed = truthyParam(params.listed, true)

    return {
      action: 'new',
      listed,
      ...(title ? { title } : {}),
      ...(cwd ? { cwd } : {}),
      ...(prompt ? { prompt } : {})
    }
  }

  // hermes://session/open/<id>  or  hermes://session/open?id=<id>
  if (name === 'open' || name.startsWith('open/')) {
    let storedSessionId = ''

    if (name.startsWith('open/')) {
      storedSessionId = name.slice('open/'.length).trim()
    }

    if (!storedSessionId) {
      storedSessionId = (params.id || params.session || params.session_id || '').trim()
    }

    if (!storedSessionId) {
      return null
    }

    return { action: 'open', storedSessionId }
  }

  return null
}

/** Build a hermes:// URL for tests and CLI helpers. */
export function buildSessionDeepLink(action: DeepLinkSessionAction): string {
  if (action.action === 'open') {
    return `hermes://session/open/${encodeURIComponent(action.storedSessionId)}`
  }

  const q = new URLSearchParams()

  if (action.title) {
    q.set('title', action.title)
  }

  if (action.cwd) {
    q.set('cwd', action.cwd)
  }

  if (action.prompt) {
    q.set('prompt', action.prompt)
  }

  if (!action.listed) {
    q.set('listed', '0')
  }

  const qs = q.toString()

  return `hermes://session/new${qs ? `?${qs}` : ''}`
}
