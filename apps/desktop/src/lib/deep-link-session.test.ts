import { describe, expect, it } from 'vitest'

import { buildSessionDeepLink, parseDeepLinkSessionAction } from './deep-link-session'

describe('parseDeepLinkSessionAction', () => {
  it('ignores non-session kinds', () => {
    expect(parseDeepLinkSessionAction({ kind: 'blueprint', name: 'x', params: {} })).toBeNull()
    expect(parseDeepLinkSessionAction(null)).toBeNull()
  })

  it('parses session/new with defaults', () => {
    expect(parseDeepLinkSessionAction({ kind: 'session', name: 'new', params: {} })).toEqual({
      action: 'new',
      listed: true
    })
  })

  it('parses session/new params', () => {
    expect(
      parseDeepLinkSessionAction({
        kind: 'session',
        name: 'new',
        params: {
          title: 'MekAcc',
          cwd: 'C:/Users/imba/git/infernos',
          prompt: 'ship it',
          listed: '0'
        }
      })
    ).toEqual({
      action: 'new',
      listed: false,
      title: 'MekAcc',
      cwd: 'C:/Users/imba/git/infernos',
      prompt: 'ship it'
    })
  })

  it('parses session/open path id', () => {
    expect(parseDeepLinkSessionAction({ kind: 'session', name: 'open/abc123', params: {} })).toEqual({
      action: 'open',
      storedSessionId: 'abc123'
    })
  })

  it('parses session/open query id', () => {
    expect(parseDeepLinkSessionAction({ kind: 'session', name: 'open', params: { id: 'xyz' } })).toEqual({
      action: 'open',
      storedSessionId: 'xyz'
    })
  })

  it('rejects open without id', () => {
    expect(parseDeepLinkSessionAction({ kind: 'session', name: 'open', params: {} })).toBeNull()
  })
})

describe('buildSessionDeepLink', () => {
  it('round-trips new', () => {
    const url = buildSessionDeepLink({
      action: 'new',
      listed: false,
      title: 'T',
      cwd: '/tmp/x',
      prompt: 'hi there'
    })

    expect(url.startsWith('hermes://session/new?')).toBe(true)
    // parse via URL to mimic main process
    const u = new URL(url)

    const action = parseDeepLinkSessionAction({
      kind: u.hostname,
      name: decodeURIComponent(u.pathname.replace(/^\//, '')),
      params: Object.fromEntries(u.searchParams.entries())
    })

    expect(action).toEqual({
      action: 'new',
      listed: false,
      title: 'T',
      cwd: '/tmp/x',
      prompt: 'hi there'
    })
  })

  it('round-trips open', () => {
    const url = buildSessionDeepLink({ action: 'open', storedSessionId: 'sess_1' })
    const u = new URL(url)

    const action = parseDeepLinkSessionAction({
      kind: u.hostname,
      name: decodeURIComponent(u.pathname.replace(/^\//, '')),
      params: Object.fromEntries(u.searchParams.entries())
    })

    expect(action).toEqual({ action: 'open', storedSessionId: 'sess_1' })
  })
})
