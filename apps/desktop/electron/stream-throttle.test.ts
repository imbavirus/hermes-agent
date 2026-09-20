import assert from 'node:assert/strict'

import { test } from 'vitest'

import { createStreamThrottle, type ThrottleWindowLike } from './stream-throttle'

function makeTimers() {
  const pending = new Map<number, () => void>()
  let nextId = 1

  return {
    clearTimeout: (handle: unknown) => {
      pending.delete(handle as number)
    },
    fire() {
      const jobs = [...pending.values()]
      pending.clear()

      for (const job of jobs) {
        job()
      }
    },
    get pendingCount() {
      return pending.size
    },
    setTimeout: (fn: () => void, _ms: number) => {
      const id = nextId++
      pending.set(id, fn)

      return id
    }
  }
}

function makeWindow() {
  const calls: boolean[] = []
  const listeners = new Map<string, () => void>()
  let destroyed = false

  const win = {
    calls,
    close() {
      destroyed = true
      listeners.get('closed')?.()
    },
    isDestroyed: () => destroyed,
    on(event: string, fn: () => void) {
      listeners.set(event, fn)
    },
    webContents: {
      isDestroyed: () => destroyed,
      setBackgroundThrottling(allowed: boolean) {
        calls.push(allowed)
      }
    }
  }

  return win
}

test('chat windows stay unthrottled even when idle — background agents keep running', () => {
  const timers = makeTimers()
  const throttle = createStreamThrottle(timers)
  const idle = makeWindow()
  throttle.register(idle)

  // Jarvis rule: an open chat is live whether it is focused or not.
  // Chromium must never throttle timers, rAF, or WS keepalive.
  assert.deepEqual(idle.calls, [false])
  assert.equal(throttle.isUnthrottled(), true)
})

test('a late window also starts unthrottled; settling a turn never re-throttles', () => {
  const timers = makeTimers()
  const throttle = createStreamThrottle(timers)
  const win = makeWindow()
  throttle.register(win)

  throttle.update(true)
  assert.deepEqual(win.calls, [false])
  assert.equal(throttle.isUnthrottled(), true)

  const late = makeWindow()
  throttle.register(late)
  assert.deepEqual(late.calls, [false])

  throttle.update(false)
  timers.fire()
  assert.deepEqual(win.calls, [false])
  assert.deepEqual(late.calls, [false])
  assert.equal(throttle.isUnthrottled(), true)
  assert.equal(timers.pendingCount, 0)
})

test('busy/idle reports never schedule a re-throttle timer', () => {
  const timers = makeTimers()
  const throttle = createStreamThrottle(timers)
  const win = makeWindow()
  throttle.register(win)

  throttle.update(true)
  throttle.update(false)
  throttle.update(true)
  throttle.update(false)
  assert.equal(timers.pendingCount, 0)
  assert.equal(throttle.isUnthrottled(), true)
  assert.deepEqual(win.calls, [false])
})

test('closed and destroyed windows drop out without throwing', () => {
  const timers = makeTimers()
  const throttle = createStreamThrottle(timers)
  const closedWin = makeWindow()
  throttle.register(closedWin)
  closedWin.close()

  const gone: ThrottleWindowLike & { on?: never } = {
    isDestroyed: () => true,
    webContents: null
  }

  throttle.register(gone)

  throttle.update(true)
  assert.deepEqual(closedWin.calls, [false])
})
