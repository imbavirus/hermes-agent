import { describe, expect, it } from 'vitest'

import { toChatMessages } from './hydration'

/**
 * Regression: the REST transcript routes serialise the INTEGER `messages.id`
 * as a JSON string ("38127"), while the gateway resume route sends an integer
 * `row_id`. The old guard was `typeof message.id === 'number'`, so every
 * windowed message got `rowId: undefined`.
 *
 * `history-window.ts` then did `messages.find(m => m.rowId === rowId)`, which
 * missed, returned null, and painted an empty transcript with no error logged
 * anywhere. This is the exact shape returned by
 * GET /api/sessions/{id}/messages/around.
 */
describe('toChatMessages rowId from a REST-serialised transcript', () => {
  it('keeps rowId when the REST payload sends id as a numeric string', () => {
    const messages = toChatMessages([
      { id: '38127', role: 'user', content: 'first prompt', timestamp: 1790637138 },
      { id: '38128', role: 'assistant', content: 'reply', timestamp: 1790637140 }
    ] as never)

    expect(messages).toHaveLength(2)
    expect(messages[0]?.rowId).toBe(38127)
    expect(messages[1]?.rowId).toBe(38128)
  })

  it('lets history-window find the anchor row the timeline asked for', () => {
    // The /timeline entry this mirrors is row_id 38127, preview "first prompt".
    const timelineEntry = { row_id: 38127 }
    const messages = toChatMessages([
      { id: '38127', role: 'user', content: 'first prompt', timestamp: 1790637138 }
    ] as never)

    // This is the exact lookup history-window.ts performs. It returned undefined
    // before the fix, so revealRow() returned null and the pane stayed empty.
    const target = messages.find(message => message.rowId === timelineEntry.row_id)

    expect(target).toBeDefined()
  })

  it('still prefers an explicit gateway row_id over id', () => {
    const messages = toChatMessages([
      { row_id: 500, id: '999', role: 'user', content: 'gateway resume', timestamp: 1 }
    ] as never)

    expect(messages[0]?.rowId).toBe(500)
  })

  it('accepts a genuine numeric id unchanged', () => {
    const messages = toChatMessages([
      { id: 1234, role: 'user', content: 'numeric', timestamp: 1 }
    ] as never)

    expect(messages[0]?.rowId).toBe(1234)
  })

  it('leaves rowId undefined for values that are not durable row ids', () => {
    const messages = toChatMessages([
      { id: 'not-a-row', role: 'user', content: 'opaque', timestamp: 1 },
      { id: '', role: 'user', content: 'empty', timestamp: 2 },
      { role: 'user', content: 'absent', timestamp: 3 },
      { id: '12.5', role: 'user', content: 'fractional', timestamp: 4 }
    ] as never)

    for (const message of messages) {
      expect(message.rowId).toBeUndefined()
    }
  })
})
