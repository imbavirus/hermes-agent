import type { LocalBackendSpawnCoordinator } from './pool-spawn-coordinator'

export interface PoolRetireEntry {
  /** An early veto only; backend admission owns the proof. */
  activeTurn?: boolean
  lastActiveAt?: null | number
  process?: unknown
}

export interface PoolRetirerDeps<E extends PoolRetireEntry> {
  pool: Map<string, E>
  coordinator: LocalBackendSpawnCoordinator
  prepare: (key: string, entry: E) => Promise<string | null>
  commit: (key: string, entry: E, token: string) => Promise<boolean>
  cancel: (key: string, entry: E, token: string) => Promise<void>
  stopBackend: (key: string) => Promise<void>
  onRetiring?: (key: string) => void
  log?: (message: string) => void
  /**
   * Idle floor a backend must clear before capacity pressure may retire it.
   * Mirrors the LRU path: being least-recently-*used* is not the same as being
   * idle, and only the backend knows whether it is still working.
   */
  reclaimFreshMs?: number
}

/** Default floor for capacity reclaim, matching the LRU path's keepalive freshness. */
const RECLAIM_FRESH_MS = 4 * 60_000

export function selectRetirementCandidates<K, E extends PoolRetireEntry>(
  entries: Iterable<[K, E]>,
  exclude: ReadonlySet<K>
): [K, E][] {
  return [...entries]
    .filter(([key, entry]) => Boolean(entry.process) && entry.activeTurn !== true && !exclude.has(key))
    .sort((a, b) => (a[1].lastActiveAt || 0) - (b[1].lastActiveAt || 0))
}

/** One arbiter owns foreground recovery, idle reaping and stale LRU eviction.
 * A permit freezes backend admission; a GET snapshot never authorizes a kill.
 * Credit: @bounce12340's occupied-not-busy diagnosis, @austinpickett's parking,
 * @chelsealong's backend-work proof and @sharkenstein3d's shared stop boundary.
 */
export function createPoolRetirer<E extends PoolRetireEntry>(deps: PoolRetirerDeps<E>) {
  let serial: Promise<unknown> = Promise.resolve()
  let scheduled = false
  let disposed = false
  const retiredScopes = new Set<string>()
  let retry: ReturnType<typeof setTimeout> | undefined
  const report = (error: unknown) => deps.log?.(`Pool retirement failed: ${String(error)}`)

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = serial.then(work)
    serial = result.catch(report)

    return result
  }

  const needsCapacity = () => !disposed && deps.coordinator.foregroundWaiters.size > 0 &&
    deps.coordinator.activeCount >= deps.coordinator.limit

  async function retire(key: string, entry: E, needed: () => boolean): Promise<boolean> {
    const eligible = () => !disposed && deps.pool.get(key) === entry && entry.activeTurn !== true && needed()

    if (!entry.process || !eligible()) {
      return false
    }

    const token = await deps.prepare(key, entry)

    if (!token) {
      return false
    }

    let committed = false

    try {
      // A different resident may have exited, the waiter withdrawn, or this
      // key acquired a new generation while the HTTP prepare was outstanding.
      if (!eligible()) {
        return false
      }

      committed = await deps.commit(key, entry, token)

      if (!committed || deps.pool.get(key) !== entry) {
        return false
      }

      // Commit is irreversible: admission remains closed even if capacity or
      // renderer intent changes now. Park before signalling the exact child.
      retiredScopes.add(key)
      deps.onRetiring?.(key)
      await deps.stopBackend(key)

      return true
    } finally {
      if (!committed) {
        await deps.cancel(key, entry, token).catch(report)
      }
    }
  }

  async function reclaim(): Promise<void> {
    // Capacity pressure is not proof of idleness. `activeTurn` is a renderer
    // lease: cron, async delegation, background processes and compaction all
    // report it false while genuinely working, so a recently-pinged backend can
    // still be busy. Without an idle floor here, one queued foreground spawn
    // retires a backend that was touched seconds ago — the "background chat
    // died while I was in another profile" failure. Require the same
    // freshness the LRU path already requires.
    const freshMs = deps.reclaimFreshMs ?? RECLAIM_FRESH_MS
    const isIdle = (entry: E) => Date.now() - (entry.lastActiveAt || 0) > freshMs

    while (needsCapacity()) {
      let retired = false
      const candidates = selectRetirementCandidates(deps.pool, deps.coordinator.foregroundWaiters)

      for (const [key, entry] of candidates) {
        if (!needsCapacity()) {
          return
        }

        if (await retire(key, entry, () => needsCapacity() && isIdle(entry))) {
          retired = true

          break
        }
      }

      if (!retired) {
        return
      }
    }
  }

  function wake(): void {
    if (scheduled || disposed) {
      return
    }

    clearTimeout(retry)
    scheduled = true
    void enqueue(reclaim).catch(report).finally(() => {
      scheduled = false

      // Busy work may finish without a renderer touch (cron / side agents).
      // The coordinator's existing ticket deadline bounds these retries.
      if (needsCapacity()) {
        retry = setTimeout(wake, 1000)
        retry.unref?.()
      }
    })
  }

  const unsubscribe = deps.coordinator.onChange(wake)

  return {
    wake,
    // Deterministic entry point for tests; `wake` is the timer-driven path.
    reclaimNow: () => enqueue(reclaim),
    assertCanOpen: (key: string, priority: 'foreground' | 'background') => {
      if (priority === 'foreground') {
        retiredScopes.delete(key)
      } else if (retiredScopes.has(key)) {
        throw new Error(`Backend for "${key}" was retired; open it explicitly to reconnect.`)
      }
    },
    retireIdle: (key: string, idleMs: number) => enqueue(async () => {
      const entry = deps.pool.get(key)

      return entry ? retire(key, entry, () => Date.now() - (entry.lastActiveAt || 0) > idleMs) : false
    }),
    evictTo: (keep: number, freshMs: number) => enqueue(async () => {
      const retired: string[] = []
      const overCap = () => [...deps.pool.values()].filter(entry => entry.process).length > Math.max(0, keep)

      for (const [key, entry] of selectRetirementCandidates(deps.pool, deps.coordinator.foregroundWaiters)) {
        if (await retire(key, entry, () => overCap() && Date.now() - (entry.lastActiveAt || 0) > freshMs)) {
          retired.push(key)
        }
      }

      return retired
    }),
    dispose: () => {
      disposed = true
      clearTimeout(retry)
      unsubscribe()
    },
  }
}
