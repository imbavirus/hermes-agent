/**
 * pool-spawn-reservation.ts
 *
 * Atomic reservation for a pooled backend slot, closing the check-then-act
 * window in ensureBackend() (main.ts).
 *
 * The bug: ensureBackend did
 *
 *   const existing = pool.get(key)      // check
 *   if (existing) return await existing
 *   await evictLruPoolBackends(...)      // yields for SECONDS (prepare/commit
 *                                        // + taskkill + 5s SIGTERM + 1s SIGKILL)
 *   const entry = {...}
 *   entry.connectionPromise = spawn(...)
 *   pool.set(key, entry)                // act
 *
 * Two concurrent callers for the same profile both read `undefined`, both
 * awaited, both spawned, and the second `pool.set` overwrote the first. The
 * loser's child stayed alive while nothing in the pool referenced it, so
 * stopPoolBackend could never reap it and a second process kept serving one
 * profile's HERMES_HOME.
 *
 * The fix: claim the key BEFORE yielding. The first caller publishes a
 * placeholder; every concurrent caller finds it and waits on its promise. The
 * placeholder is what the pool sees, so the ownership fences that already exist
 * downstream keep working unchanged.
 *
 * This is deliberately separate from BackendDialClaims: that claim dedupes
 * whole dials and is keyed by (connectionId, profile), while this one owns the
 * pool-map mutation itself and is keyed by the pool key. Using it at the
 * ensureBackend entry means the three call sites that bypassed the dial claim
 * (freshGatewayWsUrl, requestJsonForProfile, handleHermesApiRequest) are
 * covered for free, because they all funnel through here.
 */

export interface PoolReservation<T> {
  /** True when this call created the reservation (i.e. it is the spawner). */
  isOwner: boolean
  /** Resolves with the owner's result, whoever ended up owning it. */
  settled: Promise<T>
  /**
   * Publish the real entry into the pool under this key. Only the owner calls
   * this, and only after the spawn has been created — the placeholder is
   * replaced in place so no other caller can slip a second entry in between.
   */
  publish: (entry: unknown) => void
  /** Drop the reservation if the owner failed before publishing an entry. */
  abandon: () => void
}

export class PoolSpawnReservations {
  readonly #pendingByKey = new Map<
    string,
    {
      promise: Promise<unknown>
      resolve: (value: unknown) => void
      reject: (error: unknown) => void
      entry: unknown
      published: boolean
    }
  >()

  /** Whether a spawn for this key is reserved but not yet published. */
  isReserved(key: string): boolean {
    return this.#pendingByKey.has(key)
  }

  /**
   * Reserve `key`, or join the in-flight reservation.
   *
   * `spawn` is invoked ONLY for the owner, and only after the key is reserved —
   * that ordering is what makes check-and-act atomic with respect to other
   * callers in this process. Its resolution settles the reservation, so every
   * joiner receives the owner's outcome (value or error).
   */
  reserve<T>(key: string, spawn: () => Promise<T>, onPublish: (entry: unknown) => void): PoolReservation<T> {
    const existing = this.#pendingByKey.get(key)

    if (existing) {
      return {
        isOwner: false,
        settled: existing.promise as Promise<T>,
        // A joiner must never mutate the pool.
        publish: () => {},
        abandon: () => {}
      }
    }

    let resolve!: (value: unknown) => void
    let reject!: (error: unknown) => void

    const promise = new Promise<unknown>((res, rej) => {
      resolve = res
      reject = rej
    })

    const record = { promise, resolve, reject, entry: undefined as unknown, published: false }

    this.#pendingByKey.set(key, record)

    // The owner runs the spawn and settles the shared promise. Kick it off
    // eagerly so a joiner arriving later still sees the reservation.
    let pending: Promise<T>

    try {
      pending = Promise.resolve(spawn())
    } catch (error) {
      pending = Promise.reject(error)
    }

    void pending.then(
      value => {
        // Publish before settling so a caller woken by `settled` always finds
        // the entry already in the pool.
        if (!record.published) {
          record.published = true
          record.entry = value
          onPublish(value)
        }

        resolve(value)
      },
      error => {
        if (!record.published && this.#pendingByKey.get(key) === record) {
          this.#pendingByKey.delete(key)
        }

        reject(error)
      }
    )

    // Settle on both outcomes and always clear the reservation, so a failed
    // spawn is never cached as a permanent claim (fail closed, not latched).
    void promise.then(
      () => {
        if (this.#pendingByKey.get(key) === record) {
          this.#pendingByKey.delete(key)
        }
      },
      () => {
        if (this.#pendingByKey.get(key) === record) {
          this.#pendingByKey.delete(key)
        }
      }
    )

    const reservation: PoolReservation<T> = {
      isOwner: true,
      settled: promise as Promise<T>,
      publish: entry => {
        // Only adopt an entry published by the owner before the spawn settled
        // (the caller's own `entry` object, which later gains a live connection).
        if (record.published) {
          return
        }

        record.published = true
        record.entry = entry
        onPublish(entry)
      },
      abandon: () => {
        if (!record.published && this.#pendingByKey.get(key) === record) {
          this.#pendingByKey.delete(key)
        }
      }
    }

    return reservation
  }
}
