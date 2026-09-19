import { act, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type MessageStreamHarness, renderMessageStream } from './test-harness'
import { STREAM_DELTA_FLUSH_MS } from './utils'

const SID = 'dup-session'

let stream: MessageStreamHarness

async function flushDeltas() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(STREAM_DELTA_FLUSH_MS)
  })
}

describe('useMessageStream consecutive identical live deltas', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not double-append the same assistant chunk applied twice', async () => {
    vi.useFakeTimers()
    stream = renderMessageStream(SID)
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      stream.handleEvent({ payload: { text: 'Got it, baby.' }, session_id: SID, type: 'message.delta' })
      stream.handleEvent({ payload: { text: 'Got it, baby.' }, session_id: SID, type: 'message.delta' })
    })
    await flushDeltas()

    expect(stream.text()).toBe('Got it, baby.')
  })

  it('does not double-append the same reasoning chunk applied twice', async () => {
    vi.useFakeTimers()
    stream = renderMessageStream(SID)
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      stream.handleEvent({
        payload: { text: "I'll check the hair trait." },
        session_id: SID,
        type: 'reasoning.delta'
      })
      stream.handleEvent({
        payload: { text: "I'll check the hair trait." },
        session_id: SID,
        type: 'reasoning.delta'
      })
    })
    await flushDeltas()

    expect(stream.reasoningText()).toBe("I'll check the hair trait.")
  })

  it('still concatenates distinct consecutive chunks', async () => {
    vi.useFakeTimers()
    stream = renderMessageStream(SID)
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      stream.handleEvent({ payload: { text: 'Hello ' }, session_id: SID, type: 'message.delta' })
      stream.handleEvent({ payload: { text: 'world' }, session_id: SID, type: 'message.delta' })
    })
    await flushDeltas()

    expect(stream.text()).toBe('Hello world')
  })

  it('allows the same first chunk on the next turn after message.start', async () => {
    vi.useFakeTimers()
    stream = renderMessageStream(SID)
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      stream.handleEvent({ payload: { text: 'Got it, baby.' }, session_id: SID, type: 'message.delta' })
    })
    await flushDeltas()
    act(() => {
      stream.handleEvent({ payload: { text: 'Got it, baby.' }, session_id: SID, type: 'message.complete' })
      stream.handleEvent({ payload: {}, session_id: SID, type: 'message.start' })
      stream.handleEvent({ payload: { text: 'Got it, baby.' }, session_id: SID, type: 'message.delta' })
    })
    await flushDeltas()

    const assistants = stream.state().messages.filter(message => message.role === 'assistant')
    expect(assistants).toHaveLength(2)
    expect(stream.text()).toBe('Got it, baby.')
  })
})
