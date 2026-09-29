import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  createPoolRetirer,
  type PoolRetireEntry,
  type PoolRetirerDeps,
  selectRetirementCandidates
} from './pool-retire'
import { LocalBackendSpawnCoordinator } from './pool-spawn-coordinator'

test('capacity reclaim never retires a backend that is not actually idle', async () => {
  // Fill the single slot, then queue a foreground waiter so needsCapacity() is
  // true and reclaim() actually runs. The only candidate was pinged a moment ago
  // and has no renderer turn lease — exactly the shape of cron / async
  // delegation / background work, which the renderer reports as activeTurn:false.
  // It must NOT be killed.
  const entry: PoolRetireEntry = { process: {}, lastActiveAt: Date.now() }
  const pool = new Map([['busy-work', entry]])
  const stopped: string[] = []
  const coordinator = new LocalBackendSpawnCoordinator(1)
  const release = await coordinator.acquire('busy-work')
  const queued = coordinator.request('newcomer')

  const retirer = createPoolRetirer({
    pool,
    coordinator,
    prepare: async () => 'permit',
    commit: async () => true,
    cancel: async () => {},
    stopBackend: async key => { stopped.push(key) },
    reclaimFreshMs: 1000
  } satisfies PoolRetirerDeps<PoolRetireEntry>)

  try {
    assert.equal(coordinator.foregroundWaiters.has('newcomer'), true, 'test must actually be under pressure')

    await retirer.reclaimNow()

    assert.deepEqual(stopped, [], 'a freshly-pinged backend must survive a capacity reclaim')
  } finally {
    retirer.dispose()
    void queued.acquired.catch(() => {})
    queued.cancel()
    release()
  }
})

test('capacity reclaim still retires a genuinely idle backend to make room', async () => {
  const entry: PoolRetireEntry = { process: {}, lastActiveAt: 1 }
  const pool = new Map([['idle-work', entry]])
  const stopped: string[] = []
  const coordinator = new LocalBackendSpawnCoordinator(1)
  const release = await coordinator.acquire('occupant')
  const queued = coordinator.request('newcomer')

  const retirer = createPoolRetirer({
    pool,
    coordinator,
    prepare: async () => 'permit',
    commit: async () => true,
    cancel: async () => {},
    stopBackend: async key => { stopped.push(key); release() },
    reclaimFreshMs: 1000
  } satisfies PoolRetirerDeps<PoolRetireEntry>)

  try {
    await retirer.reclaimNow()

    assert.deepEqual(stopped, ['idle-work'], 'a long-idle backend must be reclaimable')
  } finally {
    retirer.dispose()
    void queued.acquired.catch(() => {})
    queued.cancel()
  }
})

test('idle and LRU retirement require backend authority, unchanged identity and current eligibility', async () => {
  for (const path of ['idle', 'lru'] as const) {
    for (const outcome of ['busy', 'unknown', 'expired', 'replaced', 'fresh', 'idle'] as const) {
      const entry: PoolRetireEntry = { process: {}, lastActiveAt: 1 }
      const pool = new Map([['a', entry]])
      const cancelled: string[] = []
      const stopped: string[] = []
      const events: string[] = []

      const retirer = createPoolRetirer({
        pool,
        coordinator: new LocalBackendSpawnCoordinator(3),
        prepare: async () => {
          if (outcome === 'replaced') {pool.set('a', { process: {}, lastActiveAt: 1 })}

          if (outcome === 'fresh') {entry.lastActiveAt = Date.now()}

          return outcome === 'busy' || outcome === 'unknown' ? null : 'permit'
        },
        commit: async () => {
          events.push('commit')

          return outcome !== 'expired'
        },
        cancel: async key => { cancelled.push(key) },
        onRetiring: () => { events.push('park') },
        stopBackend: async key => { events.push('stop'); stopped.push(key); pool.delete(key) },
      })

      try {
        if (path === 'idle') {await retirer.retireIdle('a', 1000)}
        else {await retirer.evictTo(0, 1000)}

        assert.deepEqual(stopped, outcome === 'idle' ? ['a'] : [], `${path}: ${outcome}`)

        if (outcome === 'idle') {assert.deepEqual(events, ['commit', 'park', 'stop'])}

        if (['expired', 'replaced', 'fresh'].includes(outcome)) {assert.deepEqual(cancelled, ['a'])}
      } finally {
        retirer.dispose()
      }
    }
  }
})

test('candidate selection excludes processless descriptors, renderer-leased work and queued target scopes', () => {
  const pool = new Map<string, PoolRetireEntry>([
    ['fresh', { process: {}, lastActiveAt: 100 }],
    ['old', { process: {}, lastActiveAt: 1 }],
    ['busy', { process: {}, lastActiveAt: 0, activeTurn: true }],
    ['descriptor', { process: null }],
    ['target', { process: {}, lastActiveAt: 0 }],
  ])

  assert.deepEqual(selectRetirementCandidates(pool, new Set(['target'])).map(([key]) => key), ['old', 'fresh'])
})
