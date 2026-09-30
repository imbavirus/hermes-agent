import { afterEach, describe, expect, it, vi } from 'vitest'

import { $gatewayState, $sessions, setSessions } from '@/store/session'
import { $sessionTiles } from '@/store/session-states'

import { sessionTileResumeFailure, shouldAutoResumeSessionTile, startUnrestoredTileTitleBackfill } from './session-tile'

describe('shouldAutoResumeSessionTile', () => {
  const live = {
    error: undefined as string | undefined,
    focusedStoredSessionId: 'stored-live',
    gatewayOpen: true,
    removalPending: false,
    resuming: false,
    runtimeId: undefined as string | undefined,
    storedSessionId: 'stored-live',
    workspaceMode: undefined as 'bots' | 'sessions' | undefined
  }

  it('resumes an unbound tile once the gateway is open', () => {
    expect(shouldAutoResumeSessionTile(live)).toBe(true)
  })

  it('does not resume a session the user is deleting', () => {
    // A 4001 racing the delete unbinds the tile runtime, re-arming the resume
    // effect against an id that is already gone: the resume 404s and latches an
    // error card for a chat that is on its way out. The tile's resumeTile goes
    // straight to session.resume, so it never passes the producer-level
    // isSessionRemovalPending filter that guards the primary route — this gate
    // is the only thing standing between a tombstoned id and a 404.
    expect(shouldAutoResumeSessionTile({ ...live, removalPending: true })).toBe(false)
  })

  it('waits for the gateway, a free slot, and an unbound, unlatched tile', () => {
    expect(shouldAutoResumeSessionTile({ ...live, gatewayOpen: false })).toBe(false)
    expect(shouldAutoResumeSessionTile({ ...live, runtimeId: 'rt-1' })).toBe(false)
    expect(shouldAutoResumeSessionTile({ ...live, error: 'boom' })).toBe(false)
    expect(shouldAutoResumeSessionTile({ ...live, resuming: true })).toBe(false)
  })

  it('does not resume a bot tile or a tile with live work that is being deleted', () => {
    // The removal guard must win over the bots/live-work exemptions, otherwise
    // an unfocused bot tile on its way out still resumes.
    expect(
      shouldAutoResumeSessionTile({
        ...live,
        focusedStoredSessionId: 'primary',
        removalPending: true,
        storedSessionId: 'bot-canonical',
        workspaceMode: 'bots'
      })
    ).toBe(false)
    expect(
      shouldAutoResumeSessionTile({
        ...live,
        focusedStoredSessionId: 'primary',
        hasLiveWork: true,
        removalPending: true,
        storedSessionId: 'background-tile',
        workspaceMode: 'sessions'
      })
    ).toBe(false)
  })
})

describe('sessionTileResumeFailure', () => {
  it('keeps a confirmed durable session retryable instead of repeating a stale 404', () => {
    expect(sessionTileResumeFailure('session not found', true, true)).toBe(
      'Session is still available — retry resuming it.'
    )
  })

  it('fails safe on an inconclusive durable lookup', () => {
    expect(sessionTileResumeFailure('404', false, true)).toBe('Session unavailable — you can retry resuming it.')
  })

  it('does not overwrite a tile that rebound while the lookup was pending', () => {
    expect(sessionTileResumeFailure('session not found', true, false)).toBeUndefined()
  })
})

describe('startUnrestoredTileTitleBackfill (#94167)', () => {
  afterEach(() => {
    $gatewayState.set('idle')
    $sessionTiles.set([])
    setSessions([])
  })

  it('backfills unlisted unrestored tiles by id via their ownerRoute once the gateway opens', async () => {
    const ownerRoute = { connectionId: 'conn-a', profile: 'writer' }
    setSessions([{ id: 'listed', title: 'Already listed' } as never])
    $sessionTiles.set([
      { ownerRoute, storedSessionId: 'old-chat' },
      { storedSessionId: 'listed' },
      { runtimeId: 'rt-live', storedSessionId: 'live' },
      { storedSessionId: 'bot', workspaceTabTitle: 'Bot Chat' }
    ])

    const lookup = vi.fn(async (id: string) => {
      const row = { id, title: 'Quarterly review' } as never
      setSessions(prev => [row, ...prev])

      return row
    })

    const stop = startUnrestoredTileTitleBackfill(lookup as never)
    expect(lookup).not.toHaveBeenCalled()

    $gatewayState.set('open')
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1))
    expect(lookup).toHaveBeenCalledWith('old-chat', ownerRoute)
    expect($sessions.get().find(row => row.id === 'old-chat')?.title).toBe('Quarterly review')

    // One-shot: a later reconnect does not re-probe.
    $gatewayState.set('idle')
    $gatewayState.set('open')
    expect(lookup).toHaveBeenCalledTimes(1)
    stop()
  })
})
