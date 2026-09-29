import { describe, expect, it } from 'vitest'

import { routeSessionId, sessionRoute } from '../routes'

import { isRouteSessionMismatch } from './route-session-state'

describe('isRouteSessionMismatch', () => {
  it('keeps the composer mounted when auto-compression rotates root to tip', () => {
    const sessions = [{ id: 'tip-2', _lineage_root_id: 'root-1' }]

    expect(isRouteSessionMismatch('root-1', 'tip-2', sessions)).toBe(false)
    expect(isRouteSessionMismatch('tip-2', 'root-1', sessions)).toBe(false)
  })

  it('still suppresses the previous chat while a genuinely different route loads', () => {
    const sessions = [{ id: 'selected', _lineage_root_id: null }]

    expect(isRouteSessionMismatch('next-session', 'selected', sessions)).toBe(true)
    expect(isRouteSessionMismatch('next-session', null, sessions)).toBe(true)
  })

  it('does not require a session row when the selected and routed ids already agree', () => {
    expect(isRouteSessionMismatch('same', 'same', [])).toBe(false)
    expect(isRouteSessionMismatch(null, 'same', [])).toBe(false)
  })

  it('keeps the same-session route visible while a context switch is in flight', () => {
    const sessions = [{ id: 'a', _lineage_root_id: null }]

    expect(
      isRouteSessionMismatch('a', 'a', sessions, {
        activeRuntimeId: 'r',
        contextSwitching: true,
        messagesEmpty: false,
        transcriptStoredSessionId: 'a'
      }),
      'a profile swap while route == selected must not blank the chat to the splash'
    ).toBe(false)
  })

  it('blanks the transcript when the selected view belongs to a DIFFERENT profile than the route', () => {
    // Clicking a chat in another profile: the URL already points at the new
    // profile's session, but `selectedSessionId` is still the previous
    // profile's. A bare id comparison reports "no mismatch" and leaves the old
    // profile's transcript painted under the new selection.
    const sessions = [
      { id: 'dev-session', _lineage_root_id: null },
      { id: 'themis-session', _lineage_root_id: null }
    ]

    const activeTranscript = {
      activeRuntimeId: 'runtime-dev',
      contextSwitching: false,
      messagesEmpty: false,
      transcriptStoredSessionId: 'dev-session'
    }

    // Same id on both sides, but the owners differ => must show the loader.
    expect(
      isRouteSessionMismatch('dev-session', 'dev-session', sessions, activeTranscript, {
        routedProfile: 'themis',
        selectedProfile: 'dev'
      }),
      'a profile switch must hide the previous profile transcript even when ids agree'
    ).toBe(true)

    // Same profile => unchanged behaviour, the chat stays visible.
    expect(
      isRouteSessionMismatch('dev-session', 'dev-session', sessions, activeTranscript, {
        routedProfile: 'dev',
        selectedProfile: 'dev'
      })
    ).toBe(false)

    // Only the routed side known: cannot prove a cross-profile switch, so the
    // pre-existing id-based answer stands.
    expect(
      isRouteSessionMismatch('dev-session', 'dev-session', sessions, activeTranscript, {
        routedProfile: 'themis'
      })
    ).toBe(false)

    // A blank/whitespace owner is unresolved, not a profile named ''.
    expect(
      isRouteSessionMismatch('dev-session', 'dev-session', sessions, activeTranscript, {
        routedProfile: '   ',
        selectedProfile: 'dev'
      })
    ).toBe(false)
    expect(
      isRouteSessionMismatch('dev-session', 'dev-session', sessions, activeTranscript, {
        routedProfile: '',
        selectedProfile: ''
      })
    ).toBe(false)
  })

  it('keeps only the routed chat whose active view owns an existing transcript during selection churn', () => {
    const routedSessionId = routeSessionId(sessionRoute('session-a'))

    const sessions = [
      { id: 'session-a', _lineage_root_id: null },
      { id: 'session-b', _lineage_root_id: null }
    ]

    const activeTranscript = {
      activeRuntimeId: 'runtime-a',
      contextSwitching: false,
      messagesEmpty: false,
      transcriptStoredSessionId: 'session-a'
    }

    expect(isRouteSessionMismatch(routedSessionId, null, sessions, activeTranscript)).toBe(false)
    expect(isRouteSessionMismatch(routedSessionId, 'session-b', sessions, activeTranscript)).toBe(false)

    expect(
      isRouteSessionMismatch('session-b', 'session-a', sessions, activeTranscript),
      'genuine navigation must suppress session A'
    ).toBe(true)
    expect(
      isRouteSessionMismatch(routedSessionId, null, sessions, { ...activeTranscript, contextSwitching: true }),
      'profile or connection switches must not retain the prior context'
    ).toBe(true)
    expect(
      isRouteSessionMismatch(routedSessionId, null, sessions, { ...activeTranscript, messagesEmpty: true }),
      'a route with no prior transcript must keep loading'
    ).toBe(true)
    expect(
      isRouteSessionMismatch(routedSessionId, null, sessions, {
        ...activeTranscript,
        activeRuntimeId: 'runtime-b',
        transcriptStoredSessionId: 'session-b'
      }),
      'a background chat must never publish into the routed foreground'
    ).toBe(true)
  })
})
