// Chat windows never Chromium-throttle.
//
// Background sessions must keep running as if they are being viewed: WS
// keepalive, tool streaming, rAF flushes, pool pings. Re-enabling Chromium
// throttling after the last turn settled let hidden renderers miss 60s
// keepalive pings, after which the idle reaper / LRU cap killed the backend
// and tabbing back died on session.resume (30s).
//
// Decorative loops (pets, star map) still pause themselves. This flag only
// keeps the agent surface alive.
//
// Pure and Electron-free (the WebContents surface is injected) so it can be
// unit-tested, mirroring session-windows.ts.

export interface ThrottleWindowLike {
  isDestroyed(): boolean
  webContents?: {
    isDestroyed(): boolean
    setBackgroundThrottling(allowed: boolean): void
  } | null
}

interface TimersLike {
  clearTimeout(handle: unknown): void
  setTimeout(fn: () => void, ms: number): unknown
}

export interface StreamThrottle {
  /** Always true: chat windows stay unthrottled for the life of the window. */
  isUnthrottled(): boolean
  /** Track a chat window; unthrottles immediately and stops tracking on close. */
  register(win: ThrottleWindowLike & { on?: (event: string, fn: () => void) => void }): void
  /** Kept for the active-work IPC edge. No longer re-enables throttling. */
  update(busy: boolean): void
}

export function createStreamThrottle(
  _timers: TimersLike = { clearTimeout: handle => clearTimeout(handle as never), setTimeout },
  _delayMs?: number
): StreamThrottle {
  const windows = new Set<ThrottleWindowLike>()

  function apply(win: ThrottleWindowLike) {
    if (win.isDestroyed()) {
      windows.delete(win)

      return
    }

    const contents = win.webContents

    if (!contents || contents.isDestroyed()) {
      return
    }

    try {
      contents.setBackgroundThrottling(false)
    } catch {
      // A window mid-teardown can throw; it's about to leave the set anyway.
    }
  }

  return {
    isUnthrottled: () => true,

    register(win) {
      windows.add(win)
      win.on?.('closed', () => windows.delete(win))
      apply(win)
    },

    update(_busy) {
      // Open chats stay live whether a turn is in flight or not.
    }
  }
}
