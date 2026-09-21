/**
 * Tests for electron/update-remote.ts — the remote-detection helpers that
 * keep passive update checks on the Infernos official tree
 * (imbavirus/hermes-agent) and off SSH origin.
 *
 * Run with: vitest run --project electron electron/update-remote.test.ts
 *
 * Why this matters:
 * 1. Infernos workstations keep origin=NousResearch and fork=imbavirus.
 *    A background `git fetch origin` then nags "update available" on unrelated
 *    Nous commits and, with a FIDO2/passkey key, triggers a hardware-touch
 *    prompt. The footer must ls-remote official HTTPS instead.
 * 2. isOfficialSshRemote must recognize imbavirus SSH (every URL form,
 *    case-insensitively) so the caller can swap in the anonymous HTTPS path —
 *    while NOT treating Nous, other forks, other hosts, or HTTPS as official SSH.
 */

import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  canonicalGitHubRemote,
  INFERNOS_UPDATE_CANARY,
  isOfficialRemote,
  isOfficialSshRemote,
  isSshRemote,
  OFFICIAL_REPO_CANONICAL,
  OFFICIAL_REPO_HTTPS_URL,
  resolveUpdateCheckUrl
} from './update-remote'

const NOUS_SSH = 'git@github.com:NousResearch/hermes-agent.git'
const NOUS_HTTPS = 'https://github.com/NousResearch/hermes-agent.git'
const IMBA_SSH = 'git@github.com:imbavirus/hermes-agent.git'
const IMBA_HTTPS = 'https://github.com/imbavirus/hermes-agent.git'

test('official HTTPS is imbavirus, not Nous', () => {
  assert.equal(OFFICIAL_REPO_HTTPS_URL, IMBA_HTTPS)
  assert.equal(OFFICIAL_REPO_CANONICAL, 'github.com/imbavirus/hermes-agent')
  assert.equal(canonicalGitHubRemote(OFFICIAL_REPO_HTTPS_URL), OFFICIAL_REPO_CANONICAL)
  assert.equal(INFERNOS_UPDATE_CANARY, '2026-08-28-inapp')
})

test('canonicalGitHubRemote normalizes SSH and HTTPS forms to the same value', () => {
  assert.equal(canonicalGitHubRemote(IMBA_SSH), OFFICIAL_REPO_CANONICAL)
  assert.equal(canonicalGitHubRemote('git@github.com:imbavirus/hermes-agent'), OFFICIAL_REPO_CANONICAL)
  assert.equal(canonicalGitHubRemote('ssh://git@github.com/imbavirus/hermes-agent.git'), OFFICIAL_REPO_CANONICAL)
  assert.equal(canonicalGitHubRemote(IMBA_HTTPS), OFFICIAL_REPO_CANONICAL)
  assert.equal(canonicalGitHubRemote('git@github.com:IMBAVIRUS/hermes-agent.git'), OFFICIAL_REPO_CANONICAL)
  assert.equal(canonicalGitHubRemote('https://github.com/imbavirus/hermes-agent/'), OFFICIAL_REPO_CANONICAL)
})

test('canonicalGitHubRemote is empty for falsy input', () => {
  assert.equal(canonicalGitHubRemote(''), '')
  assert.equal(canonicalGitHubRemote(null), '')
  assert.equal(canonicalGitHubRemote(undefined), '')
})

test('isSshRemote detects scp-like and ssh:// forms only', () => {
  assert.equal(isSshRemote(IMBA_SSH), true)
  assert.equal(isSshRemote(NOUS_SSH), true)
  assert.equal(isSshRemote('ssh://git@github.com/imbavirus/hermes-agent.git'), true)
  assert.equal(isSshRemote(IMBA_HTTPS), false)
  assert.equal(isSshRemote(''), false)
  assert.equal(isSshRemote(null), false)
})

test('isOfficialRemote is true only for imbavirus/hermes-agent', () => {
  assert.equal(isOfficialRemote(IMBA_HTTPS), true)
  assert.equal(isOfficialRemote(IMBA_SSH), true)
  assert.equal(isOfficialRemote('https://github.com/imbavirus/hermes-agent'), true)
  assert.equal(isOfficialRemote(NOUS_HTTPS), false)
  assert.equal(isOfficialRemote(NOUS_SSH), false)
  assert.equal(isOfficialRemote('git@github.com:someuser/hermes-agent.git'), false)
  assert.equal(isOfficialRemote(''), false)
  assert.equal(isOfficialRemote(null), false)
})

test('isOfficialSshRemote is true only for imbavirus over SSH', () => {
  assert.equal(isOfficialSshRemote(IMBA_SSH), true)
  assert.equal(isOfficialSshRemote('git@github.com:imbavirus/hermes-agent'), true)
  assert.equal(isOfficialSshRemote('ssh://git@github.com/imbavirus/hermes-agent.git'), true)
  assert.equal(isOfficialSshRemote('git@github.com:IMBAVIRUS/hermes-agent.git'), true)
})

test('isOfficialSshRemote does NOT match Nous, forks, other hosts, or HTTPS', () => {
  assert.equal(isOfficialSshRemote(NOUS_SSH), false)
  assert.equal(isOfficialSshRemote('git@github.com:someuser/hermes-agent.git'), false)
  assert.equal(isOfficialSshRemote('git@gitlab.com:imbavirus/hermes-agent.git'), false)
  assert.equal(isOfficialSshRemote(IMBA_HTTPS), false)
  assert.equal(isOfficialSshRemote(NOUS_HTTPS), false)
  assert.equal(isOfficialSshRemote(''), false)
  assert.equal(isOfficialSshRemote(null), false)
})

test('passive check URL is official HTTPS even when origin is Nous', () => {
  assert.equal(resolveUpdateCheckUrl(NOUS_SSH), IMBA_HTTPS)
  assert.equal(resolveUpdateCheckUrl(NOUS_HTTPS), IMBA_HTTPS)
  assert.equal(resolveUpdateCheckUrl(IMBA_SSH), IMBA_HTTPS)
  assert.equal(resolveUpdateCheckUrl(IMBA_HTTPS), IMBA_HTTPS)
  assert.equal(resolveUpdateCheckUrl(''), IMBA_HTTPS)
  assert.equal(resolveUpdateCheckUrl(null), IMBA_HTTPS)
})
