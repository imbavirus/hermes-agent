/**
 * Tests for electron/session-inbox.ts — agent-safe Desktop session open path.
 *
 * Run with: vitest run --project electron electron/session-inbox.test.ts
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, test } from 'vitest'

import {
  payloadToDeepLinkUrl,
  sessionInboxDir,
  startSessionInboxWatcher,
  type DeepLinkPayload
} from './session-inbox'

const tempHomes: string[] = []

afterEach(() => {
  for (const home of tempHomes.splice(0)) {
    try {
      fs.rmSync(home, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-session-inbox-'))
  tempHomes.push(home)
  return home
}

test('sessionInboxDir nests under hermes home', () => {
  const home = makeHome()
  assert.equal(sessionInboxDir(home), path.join(home, 'run', 'desktop-session-inbox'))
})

test('payloadToDeepLinkUrl builds session/new with params', () => {
  const url = payloadToDeepLinkUrl({
    kind: 'session',
    name: 'new',
    params: { title: 'T', cwd: 'C:/x', listed: '0' }
  })
  assert.ok(url.startsWith('hermes://session/new?'))
  const u = new URL(url)
  assert.equal(u.hostname, 'session')
  assert.equal(decodeURIComponent(u.pathname.replace(/^\//, '')), 'new')
  assert.equal(u.searchParams.get('title'), 'T')
  assert.equal(u.searchParams.get('listed'), '0')
})

test('payloadToDeepLinkUrl builds session/open/<id>', () => {
  const url = payloadToDeepLinkUrl({
    kind: 'session',
    name: 'open/abc123',
    params: {}
  })
  assert.ok(url.includes('session'))
  assert.ok(url.includes('open'))
  assert.ok(url.includes('abc123'))
})

test('watcher drains existing inbox JSON on start', async () => {
  const home = makeHome()
  const dir = sessionInboxDir(home)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'pending.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      url: 'hermes://session/new?title=drain-me'
    }),
    'utf8'
  )

  const delivered: DeepLinkPayload[] = []
  const stop = startSessionInboxWatcher({
    hermesHome: home,
    deliver: p => delivered.push(p)
  })

  // drain is sync at start
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0]?.kind, 'session')
  assert.equal(delivered[0]?.name, 'new')
  assert.equal(delivered[0]?.params.title, 'drain-me')
  assert.equal(fs.existsSync(file), false, 'request file consumed')

  stop()
})

test('watcher delivers newly written inbox file', async () => {
  const home = makeHome()
  const delivered: DeepLinkPayload[] = []
  const stop = startSessionInboxWatcher({
    hermesHome: home,
    deliver: p => delivered.push(p)
  })

  const dir = sessionInboxDir(home)
  const file = path.join(dir, `${Date.now()}.json`)
  fs.writeFileSync(
    file,
    JSON.stringify({
      kind: 'session',
      name: 'new',
      params: { title: 'live', prompt: 'hi' }
    }),
    'utf8'
  )

  // watch is async with 50ms settle
  const deadline = Date.now() + 2000
  while (delivered.length === 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 50))
  }

  assert.equal(delivered.length, 1)
  assert.equal(delivered[0]?.params.title, 'live')
  assert.equal(delivered[0]?.params.prompt, 'hi')
  stop()
})

test('bad json is ignored without throwing', () => {
  const home = makeHome()
  const dir = sessionInboxDir(home)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'bad.json'), '{not-json', 'utf8')

  const delivered: DeepLinkPayload[] = []
  const stop = startSessionInboxWatcher({
    hermesHome: home,
    deliver: p => delivered.push(p)
  })
  assert.equal(delivered.length, 0)
  stop()
})
