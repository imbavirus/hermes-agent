import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setApiRequestConnection, setApiRequestLocalMode, setApiRequestProfile } from './client'
import { getAllSessionMessages, getSessionMessages } from './sessions'

const row = (id: number) => ({ id, role: 'user' as const, content: `message ${id}`, timestamp: 1_000 + id })

const page = (messages: ReturnType<typeof row>[]) => ({
  session_id: 'stored-session',
  profile: 'mia',
  messages,
  pagination: { limit: 500, offset: 0, order: 'latest', returned: messages.length }
})

/**
 * Regression: a session opened on a MULTIPLEX gateway.
 *
 * The owning profile of a listed session is not the gateway's default profile, and
 * the backend 404s an untagged transcript read:
 *
 *   GET /api/sessions/{id}/messages?profile=mia      -> 200, 500 messages
 *   GET /api/sessions/{id}/messages                  -> 404
 *
 * `capabilityScoped()` drops a string scope, so `sessionScoped('mia')` used to
 * return `{}` and the read went out untagged. The transcript came back empty, the
 * chat hydrated to nothing, and the pane rendered blank with no console error.
 *
 * A bare string scope is exactly what `resolveSessionProfile()` returns, so this
 * is the shape the live open path actually passes.
 */
describe('session transcript reads keep a resolved string profile', () => {
  const api = vi.fn()

  beforeEach(() => {
    api.mockReset()
    Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { api } })
    setApiRequestProfile('default')
    setApiRequestLocalMode(true)
  })

  afterEach(() => {
    setApiRequestLocalMode(false)
    setApiRequestConnection(null)
    setApiRequestProfile(null)
    Reflect.deleteProperty(window, 'hermesDesktop')
  })

  it('tags the read with the profile when given a bare string scope', async () => {
    api.mockResolvedValueOnce(page([row(1)]))

    await getSessionMessages('stored-session', 'mia')

    // Without ?profile= the backend 404s and the transcript is empty.
    expect(api).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profile: 'mia',
        path: '/api/sessions/stored-session/messages?profile=mia'
      })
    )
  })

  it('does not tag a read that was given no scope at all', async () => {
    api.mockResolvedValueOnce(page([row(1)]))

    await getSessionMessages('stored-session')

    expect(api).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: '/api/sessions/stored-session/messages' })
    )
    expect(String(api.mock.calls.at(-1)?.[0]?.path)).not.toContain('profile=')
  })

  it('ignores a blank string scope', async () => {
    api.mockResolvedValueOnce(page([row(1)]))

    await getSessionMessages('stored-session', '   ')

    expect(String(api.mock.calls.at(-1)?.[0]?.path)).not.toContain('profile=')
  })

  it('keeps an explicit object scope working alongside the string form', async () => {
    api.mockResolvedValueOnce(page([row(1)]))

    await getSessionMessages('stored-session', { connectionId: 'local', profile: 'mia' })

    expect(api).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connectionId: 'local',
        profile: 'mia',
        path: '/api/sessions/stored-session/messages?profile=mia'
      })
    )
  })

  it('tags the first page of a full transcript read', async () => {
    api.mockResolvedValueOnce(page([row(1)]))

    await getAllSessionMessages('stored-session', 'mia')

    expect(String(api.mock.calls[0]?.[0]?.path)).toContain('profile=mia')
  })
})
