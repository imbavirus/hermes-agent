/**
 * Pure helpers for choosing a remote URL during passive update checks.
 *
 * Infernos official tree is `imbavirus/hermes-agent`, not NousResearch.
 * Workstations keep `origin=git@github.com:NousResearch/hermes-agent.git`
 * and `fork=imbavirus`. A background `git fetch origin` then:
 *   - nags "update available" on unrelated Nous commits
 *   - with a FIDO2/passkey key, triggers an unexplained hardware-touch prompt
 *
 * Passive checks therefore always `ls-remote` the public HTTPS official URL
 * (no auth, cannot prompt). Active update/apply still runs `hermes update`,
 * which already prefers origin-if-official else `fork`.
 *
 * Extracted from main.ts so the security-critical remote detection is unit
 * testable without booting Electron (main.ts requires('electron') at load).
 */

const OFFICIAL_REPO_HTTPS_URL = 'https://github.com/imbavirus/hermes-agent.git'
const OFFICIAL_REPO_CANONICAL = 'github.com/imbavirus/hermes-agent'

// Normalize common GitHub remote URL forms to `host/owner/repo` (lowercased,
// no trailing slash, no .git suffix) so SSH and HTTPS forms of the same repo
// compare equal.
function canonicalGitHubRemote(url) {
  if (!url) {
    return ''
  }

  let value = String(url).trim()

  if (value.startsWith('git@github.com:')) {
    value = `github.com/${value.slice('git@github.com:'.length)}`
  } else if (value.startsWith('ssh://git@github.com/')) {
    value = `github.com/${value.slice('ssh://git@github.com/'.length)}`
  } else {
    try {
      const parsed = new URL(value)

      if (parsed.hostname && parsed.pathname) {
        value = `${parsed.hostname}${parsed.pathname}`
      }
    } catch {
      // Leave non-URL forms unchanged.
    }
  }

  value = value.trim().replace(/\/+$/, '')

  if (value.endsWith('.git')) {
    value = value.slice(0, -4)
  }

  return value.toLowerCase()
}

function isSshRemote(url) {
  const value = String(url || '')
    .trim()
    .toLowerCase()

  return value.startsWith('git@') || value.startsWith('ssh://')
}

function isOfficialRemote(url) {
  return canonicalGitHubRemote(url) === OFFICIAL_REPO_CANONICAL
}

function isOfficialSshRemote(url) {
  return isSshRemote(url) && isOfficialRemote(url)
}

// Footer / passive check target. Always official HTTPS so a Nous `origin`
// cannot mint a false "update available" or FIDO2-prompt on fetch.
function resolveUpdateCheckUrl(_originUrl) {
  return OFFICIAL_REPO_HTTPS_URL
}

export {
  canonicalGitHubRemote,
  isOfficialRemote,
  isOfficialSshRemote,
  isSshRemote,
  OFFICIAL_REPO_CANONICAL,
  OFFICIAL_REPO_HTTPS_URL,
  resolveUpdateCheckUrl
}
