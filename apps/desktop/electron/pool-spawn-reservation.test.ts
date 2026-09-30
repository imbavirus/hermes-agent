import assert from 'node:assert/strict'

import { test } from 'vitest'

import { PoolSpawnReservations } from './pool-spawn-reservation'

test('concurrent spawn requests for one key start exactly one child', async () => {
  // Reproduces the ensureBackend race: the old code read the pool, then awaited
  // eviction (seconds), then published. Two callers both saw an empty pool and
  // both spawned, so one live child ended up referenced by nothing.
  const reservations = new PoolSpawnReservations()
  const pool = new Map<string, unknown>()
  let spawns = 0

  const request = () =>
    reservations.reserve(
      'dev',
      // Stands in for the spawn: the multi-second yield that let the second
      // caller slip past the old check.
      async () => {
        spawns += 1
        await new Promise(resolve => setTimeout(resolve, 20))

        return { process: {}, port: 1234 }
      },
      entry => {
        pool.set('dev', entry)
      }
    )

  const a = request()
  const b = request()
  const c = request()

  const [ra, rb, rc] = await Promise.all([a.settled, b.settled, c.settled])

  assert.equal(spawns, 1, 'exactly one child may be spawned per key')
  assert.equal(pool.size, 1, 'the pool must hold exactly one entry for the key')
  assert.equal([a, b, c].filter(r => r.isOwner).length, 1, 'exactly one caller owns the spawn')
  // Every caller is handed the owner's live connection, not a copy of it.
  assert.equal(ra, rb)
  assert.equal(rb, rc)
})

test('every concurrent caller receives the owner result', async () => {
  const reservations = new PoolSpawnReservations()
  const pool = new Map<string, unknown>()
  let spawns = 0

  const run = () =>
    reservations.reserve(
      'mia',
      async () => {
        spawns += 1
        await new Promise(resolve => setTimeout(resolve, 10))

        return { port: 5555 }
      },
      entry => {
        pool.set('mia', entry)
      }
    ).settled

  const results = await Promise.all([run(), run(), run(), run()])

  assert.equal(spawns, 1)
  assert.deepEqual(results, [{ port: 5555 }, { port: 5555 }, { port: 5555 }, { port: 5555 }])
})

test('a failed spawn does not latch — the next request runs fresh', async () => {
  const reservations = new PoolSpawnReservations()
  const pool = new Map<string, unknown>()
  let attempts = 0

  const run = (shouldFail: boolean) =>
    reservations.reserve(
      'themis',
      async () => {
        attempts += 1
        await Promise.resolve()

        if (shouldFail) {
          throw new Error('port announcement timed out')
        }

        return { port: 1 }
      },
      entry => {
        pool.set('themis', entry)
      }
    ).settled

  await assert.rejects(run(true), /port announcement timed out/)
  assert.equal(reservations.isReserved('themis'), false, 'a failed spawn must release the key')

  // The retry must actually spawn rather than joining the dead claim.
  assert.deepEqual(await run(false), { port: 1 })
  assert.equal(attempts, 2)
})

test('a joiner can never mutate the pool', async () => {
  const reservations = new PoolSpawnReservations()
  const pool = new Map<string, unknown>()
  let spawns = 0

  const first = reservations.reserve(
    'dev',
    async () => {
      spawns += 1

      return { port: 1 }
    },
    entry => {
      pool.set('dev', entry)
    }
  )

  const second = reservations.reserve(
    'dev',
    async () => {
      spawns += 1

      return { port: 2 }
    },
    entry => {
      pool.set('dev', entry)
    }
  )

  assert.equal(second.isOwner, false)
  second.publish({ port: 999 })
  second.abandon()

  await Promise.all([first.settled, second.settled])

  assert.equal(spawns, 1, 'a joiner must not run the spawn')
  assert.deepEqual(pool.get('dev'), { port: 1 }, 'a joiner publish must be a no-op')
})

test('different keys do not block each other', async () => {
  const reservations = new PoolSpawnReservations()
  const pool = new Map<string, unknown>()
  let spawns = 0

  const run = (key: string, delay: number) =>
    reservations.reserve(
      key,
      async () => {
        spawns += 1
        await new Promise(resolve => setTimeout(resolve, delay))

        return { key }
      },
      entry => {
        pool.set(key, entry)
      }
    ).settled

  const results = await Promise.all([run('a', 30), run('b', 1), run('c', 15)])

  assert.equal(spawns, 3, 'distinct profiles must spawn independently')
  assert.deepEqual(results, [{ key: 'a' }, { key: 'b' }, { key: 'c' }])
  assert.equal(pool.size, 3)
})
