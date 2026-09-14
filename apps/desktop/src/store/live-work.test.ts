import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ClientSessionState } from '@/app/types'

import { $compactingSessions, setSessionCompacting } from './compaction'
import { $backgroundStatusBySession } from './composer-status'
import { $liveWorkSessionIds } from './live-work'
import { $sessions } from './session'
import { clearAllSessionStates, publishSessionState } from './session-states'

const busy = (storedSessionId: string, isBusy: boolean) =>
  ({ busy: isBusy, needsInput: false, storedSessionId }) as ClientSessionState

beforeEach(() => {
  clearAllSessionStates()
  $sessions.set([])
  $backgroundStatusBySession.set({})
  $compactingSessions.set({})
})

afterEach(() => {
  clearAllSessionStates()
  $sessions.set([])
  $backgroundStatusBySession.set({})
  $compactingSessions.set({})
})

describe('$liveWorkSessionIds', () => {
  it('includes a busy turn', () => {
    publishSessionState('runtime-1', busy('stored-1', true))

    expect($liveWorkSessionIds.get()).toContain('stored-1')
  })

  it('includes a background process after the turn settles', () => {
    $sessions.set([{ id: 'stored-1', title: 'bg' } as (typeof $sessions.value)[number]])
    publishSessionState('runtime-1', busy('stored-1', false))
    $backgroundStatusBySession.set({
      'runtime-1': [{ id: 'p1', state: 'running', title: 'build', type: 'background' }]
    })

    expect($liveWorkSessionIds.get()).toContain('stored-1')
  })

  it('drops a session once both the turn and the background process are gone', () => {
    publishSessionState('runtime-1', busy('stored-1', true))
    publishSessionState('runtime-1', busy('stored-1', false))
    $backgroundStatusBySession.set({})

    expect($liveWorkSessionIds.get()).not.toContain('stored-1')
  })

  it('includes a compacting session even when the turn is not marked busy', () => {
    // Auto-summarize can run after the turn settles (busy=false) or while busy
    // flickers. Chromium throttle + gateway keep-set key off live work, so a
    // "Summarizing thread" chat must stay in the set or the continue after
    // compact waits for that tab to be focused.
    publishSessionState('runtime-1', busy('stored-1', false))
    setSessionCompacting('runtime-1', true)

    expect($liveWorkSessionIds.get()).toContain('stored-1')
  })

  it('drops a compacting session once summarization ends', () => {
    publishSessionState('runtime-1', busy('stored-1', false))
    setSessionCompacting('runtime-1', true)
    setSessionCompacting('runtime-1', false)

    expect($liveWorkSessionIds.get()).not.toContain('stored-1')
  })
})
