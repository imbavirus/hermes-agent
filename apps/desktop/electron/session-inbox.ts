/**
 * Agent/CLI → Desktop session requests without spawning a second Hermes.exe.
 *
 * Writing a JSON file into `$HERMES_HOME/run/desktop-session-inbox/` is the
 * safe path for external tools (MCP). The running main process watches the
 * directory and feeds each request through the same handleDeepLink pipeline
 * used by hermes:// URLs — no second-instance race, no port fight.
 *
 * File shape:
 *   { "url": "hermes://session/new?...", "ts": 123 }
 * or the structured form:
 *   { "kind": "session", "name": "new", "params": { "title": "..." }, "ts": 123 }
 */

import fs from 'node:fs'
import path from 'node:path'

export type DeepLinkPayload = {
  kind: string
  name: string
  params: Record<string, string>
}

export function sessionInboxDir(hermesHome: string): string {
  return path.join(hermesHome, 'run', 'desktop-session-inbox')
}

function parseUrlToPayload(url: string): DeepLinkPayload | null {
  try {
    const parsed = new URL(url)

    if (parsed.protocol !== 'hermes:') {
      return null
    }

    const kind = parsed.hostname || ''
    const name = decodeURIComponent((parsed.pathname || '').replace(/^\//, ''))
    const params: Record<string, string> = {}
    parsed.searchParams.forEach((v, k) => {
      params[k] = v
    })

    if (!kind) {
      return null
    }

    return { kind, name, params }
  } catch {
    return null
  }
}

function payloadFromJson(raw: unknown): DeepLinkPayload | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const obj = raw as Record<string, unknown>

  if (typeof obj.url === 'string' && obj.url.trim()) {
    return parseUrlToPayload(obj.url.trim())
  }

  const kind = typeof obj.kind === 'string' ? obj.kind : ''
  const name = typeof obj.name === 'string' ? obj.name : ''
  const paramsIn = obj.params && typeof obj.params === 'object' ? (obj.params as Record<string, unknown>) : {}
  const params: Record<string, string> = {}

  for (const [k, v] of Object.entries(paramsIn)) {
    if (v === undefined || v === null) {
      continue
    }

    params[k] = String(v)
  }

  if (!kind) {
    return null
  }

  return { kind, name, params }
}

function deliverFile(
  filePath: string,
  deliver: (payload: DeepLinkPayload) => void,
  log: (msg: string) => void
): void {
  let text: string

  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch (err) {
    log(`[session-inbox] read failed ${path.basename(filePath)}: ${(err as Error).message}`)

    return
  }

  let json: unknown

  try {
    json = JSON.parse(text)
  } catch (err) {
    log(`[session-inbox] bad json ${path.basename(filePath)}: ${(err as Error).message}`)
    try {
      fs.unlinkSync(filePath)
    } catch {
      /* ignore */
    }

    return
  }

  const payload = payloadFromJson(json)

  try {
    fs.unlinkSync(filePath)
  } catch {
    /* ignore */
  }

  if (!payload) {
    log(`[session-inbox] ignored ${path.basename(filePath)} (no payload)`)

    return
  }

  try {
    deliver(payload)
    log(`[session-inbox] delivered ${payload.kind}/${payload.name}`)
  } catch (err) {
    log(`[session-inbox] deliver failed: ${(err as Error).message}`)
  }
}

/**
 * Start watching the inbox. Returns a stop function.
 * Processes any files already present, then watches for new ones.
 */
export function startSessionInboxWatcher({
  hermesHome,
  deliver,
  log = () => undefined
}: {
  hermesHome: string
  deliver: (payload: DeepLinkPayload) => void
  log?: (msg: string) => void
}): () => void {
  const dir = sessionInboxDir(hermesHome)

  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    log(`[session-inbox] mkdir failed: ${(err as Error).message}`)

    return () => undefined
  }

  // Drain existing requests first (agent wrote while Desktop was starting).
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) {
        continue
      }

      deliverFile(path.join(dir, name), deliver, log)
    }
  } catch (err) {
    log(`[session-inbox] drain failed: ${(err as Error).message}`)
  }

  let watcher: fs.FSWatcher | null = null

  try {
    watcher = fs.watch(dir, (eventType, filename) => {
      if (!filename || !String(filename).endsWith('.json')) {
        return
      }

      // rename/change can fire before the writer finishes — small delay.
      const full = path.join(dir, String(filename))
      setTimeout(() => {
        if (!fs.existsSync(full)) {
          return
        }

        deliverFile(full, deliver, log)
      }, 50)
    })
    log(`[session-inbox] watching ${dir}`)
  } catch (err) {
    log(`[session-inbox] watch failed: ${(err as Error).message}`)
  }

  return () => {
    try {
      watcher?.close()
    } catch {
      /* ignore */
    }
  }
}

/** Reconstruct a hermes:// URL from a payload (for handleDeepLink string path). */
export function payloadToDeepLinkUrl(payload: DeepLinkPayload): string {
  const qs = new URLSearchParams(payload.params || {}).toString()
  const name = payload.name ? `/${encodeURIComponent(payload.name).replace(/%2F/gi, '/')}` : ''

  // Keep path slashes in open/<id> readable: encodeURIComponent of full name
  // turns open/id into open%2Fid which handleDeepLink already decodeURIComponents.
  return `hermes://${payload.kind}${name}${qs ? `?${qs}` : ''}`
}
