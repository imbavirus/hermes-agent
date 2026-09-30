import { expect, it } from 'vitest'

import { type ChatMessage, preserveLocalAssistantErrors, textPart, toChatMessages } from './index'

const row = (id: string, role: 'user' | 'assistant', text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role,
  parts: [textPart(text)],
  ...extra
})

it('reconciles only the represented failed tail, retaining its structured error and omitted segments', () => {
  const hydrated = toChatMessages([
    { role: 'user', content: 'read it', timestamp: 1 },
    {
      role: 'assistant',
      content: '',
      timestamp: 2,
      tool_calls: [{ id: 'call', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }]
    },
    { role: 'tool', tool_call_id: 'call', tool_name: 'read_file', content: 'contents', timestamp: 3 },
    { role: 'assistant', content: 'Done.', timestamp: 4 }
  ])

  const storedAssistant = hydrated.find(message => message.role === 'assistant')!

  const failed = row('local-failure', 'assistant', 'Done.', {
    parts: storedAssistant.parts,
    error: 'connection lost after completion',
    errorSurface: { code: 'transport_lost', layer: 'streaming', retryable: true }
  })

  for (const id of [failed.id, storedAssistant.id]) {
    const merged = preserveLocalAssistantErrors(hydrated, [row('local-user', 'user', 'read it'), { ...failed, id }])
    expect(merged.filter(message => message.role === 'assistant')).toHaveLength(1)
    expect(merged.at(-1)).toMatchObject({
      id: storedAssistant.id,
      error: failed.error,
      errorSurface: failed.errorSurface,
      pending: false
    })
  }

  const user = row('user', 'user', 'read it')
  const earlier = row('earlier', 'assistant', 'Done.')
  const laterUser = row('later-user', 'user', 'read it')

  const cases: { name: string; stored: ChatMessage[]; local: ChatMessage[] }[] = [
    {
      name: 'omitted continuation',
      stored: [user, earlier],
      local: [user, earlier, row('hidden', 'user', 'Continue.', { hidden: true }), failed]
    },
    { name: 'older failed segment', stored: [user, earlier], local: [user, failed, earlier] },
    { name: 'repeated prompt', stored: [user, earlier], local: [user, earlier, laterUser, failed] },
    { name: 'older identical text', stored: [user, earlier, laterUser], local: [user, earlier, laterUser, failed] },
    {
      name: 'different attachments',
      stored: [{ ...user, attachmentRefs: ['a.png'] }, earlier],
      local: [{ ...user, attachmentRefs: ['b.png'] }, failed]
    },
    {
      name: 'different durable row',
      stored: [user, { ...earlier, rowId: 10 }],
      local: [user, { ...failed, rowId: 20 }]
    },
    {
      name: 'reused tool id across turns',
      stored: [user, storedAssistant, laterUser],
      local: [user, storedAssistant, laterUser, failed]
    }
  ]

  for (const fixture of cases) {
    const merged = preserveLocalAssistantErrors(fixture.stored, fixture.local)
    expect(merged.find(message => message.id === failed.id)?.error, fixture.name).toBe(failed.error)

    for (const stored of fixture.stored.filter(message => message.role === 'assistant')) {
      expect(merged.find(message => message.id === stored.id)?.error, fixture.name).toBeUndefined()
    }
  }

  const current = [user, row('earlier-live', 'assistant', 'First.'), failed]
  const stored = [user, row('earlier-stored', 'assistant', 'First.'), earlier]
  const merged = preserveLocalAssistantErrors(stored, current)
  expect(merged.map(message => message.id)).toEqual(stored.map(message => message.id))
  expect(merged.at(-1)).toMatchObject({ error: failed.error, errorSurface: failed.errorSurface })
})

it('keeps an interrupted turn in place instead of hoisting it above newer messages', () => {
  // Reproduces the real transcript, taken from profile `mia` session
  // 20260929_011217_770935. The stored order is correct and interleaved; the
  // interrupted turn (Operation interrupted) has no completed assistant reply,
  // so it is preserved from the local cache and appended at the end — dragging
  // the *older* user turn up with it. The rendered view then shows two user
  // bubbles with the newer one on top.
  const olderUser = row('u-38519', 'user', 'the whole time i was tabbed to themis now')
  const olderReply = row('a-38520', 'assistant', "That's the keep-alive contract breaking.")
  const interrupted = row('a-38523', 'assistant', 'Operation interrupted.', { error: 'interrupted' })
  const newerUser = row('u-38524', 'user', 'also look at where my messages jump to')

  const stored = [olderUser, olderReply, newerUser]
  const local = [olderUser, olderReply, interrupted, newerUser]

  const merged = preserveLocalAssistantErrors(stored, local)
  const order = merged.filter(message => !message.hidden).map(message => message.id)

  // The interrupted turn belongs where it was written, between the reply it
  // followed and the user message that came after it.
  expect(order).toEqual(['u-38519', 'a-38520', 'a-38523', 'u-38524'])
  expect(merged.find(message => message.id === 'a-38523')).toMatchObject({ error: 'interrupted', pending: false })
})
