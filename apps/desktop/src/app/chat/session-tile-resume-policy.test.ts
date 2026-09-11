import { describe, expect, it } from 'vitest'

import { shouldAutoResumeSessionTile, shouldShowSessionTileSpinner } from './session-tile'

const base = {
  error: undefined as string | undefined,
  focusedStoredSessionId: 'stored-focused',
  gatewayOpen: true,
  resuming: false,
  runtimeId: undefined as string | undefined,
  storedSessionId: 'stored-focused',
  workspaceMode: undefined as 'bots' | 'sessions' | undefined
}

describe('shouldAutoResumeSessionTile', () => {
  it('resumes a focused sessions-mode tile with no live runtime', () => {
    expect(shouldAutoResumeSessionTile(base)).toBe(true)
  })

  it('does not resume an unfocused sessions-mode tile (ws_orphan_reap storm)', () => {
    expect(
      shouldAutoResumeSessionTile({
        ...base,
        focusedStoredSessionId: 'some-other-chat',
        storedSessionId: '20260901_214516_f5a072',
        workspaceMode: 'sessions'
      })
    ).toBe(false)
  })

  it('treats a missing workspaceMode as sessions (legacy tiles)', () => {
    expect(
      shouldAutoResumeSessionTile({
        ...base,
        focusedStoredSessionId: 'primary',
        storedSessionId: 'background-tile',
        workspaceMode: undefined
      })
    ).toBe(false)
  })

  it('still resumes an unfocused Bot Mode tile so inbound room traffic stays bound', () => {
    expect(
      shouldAutoResumeSessionTile({
        ...base,
        focusedStoredSessionId: 'primary',
        storedSessionId: 'bot-canonical',
        workspaceMode: 'bots'
      })
    ).toBe(true)
  })

  it('resumes an unfocused sessions-mode tile that still has live work', () => {
    expect(
      shouldAutoResumeSessionTile({
        ...base,
        focusedStoredSessionId: 'some-other-chat',
        hasLiveWork: true,
        storedSessionId: '20260901_214516_f5a072',
        workspaceMode: 'sessions'
      })
    ).toBe(true)
  })

  it('does not resume while the gateway is down, a runtime is bound, an error is latched, or a resume is in flight', () => {
    expect(shouldAutoResumeSessionTile({ ...base, gatewayOpen: false })).toBe(false)
    expect(shouldAutoResumeSessionTile({ ...base, runtimeId: 'live-1' })).toBe(false)
    expect(shouldAutoResumeSessionTile({ ...base, error: 'resume failed' })).toBe(false)
    expect(shouldAutoResumeSessionTile({ ...base, resuming: true })).toBe(false)
  })
})

describe('shouldShowSessionTileSpinner', () => {
  it('shows the Hermes loader only on first hydrate (no runtime, nothing parked)', () => {
    expect(shouldShowSessionTileSpinner({ parkedMessageCount: 0 })).toBe(true)
  })

  it('does not flash the loader while a previously-bound tile rebinds after reclaim', () => {
    expect(
      shouldShowSessionTileSpinner({
        parkedMessageCount: 3,
        runtimeId: undefined
      })
    ).toBe(false)
  })

  it('does not show the loader when a live runtime is bound, even with no parked tail', () => {
    expect(shouldShowSessionTileSpinner({ parkedMessageCount: 0, runtimeId: 'live-1' })).toBe(false)
  })
})
