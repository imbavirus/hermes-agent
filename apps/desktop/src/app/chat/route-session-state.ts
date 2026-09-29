import { sessionMatchesStoredId } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

interface ActiveTranscriptState {
  activeRuntimeId: null | string
  contextSwitching: boolean
  messagesEmpty: boolean
  transcriptStoredSessionId: null | string
}

/**
 * Profile ownership of the routed vs the selected view. Either side may be
 * absent, so a half-resolved pair is never mistaken for a real profile name.
 */
interface RouteProfileState {
  routedProfile?: null | string
  selectedProfile?: null | string
}

function normaliseProfile(profile: null | string | undefined): null | string {
  if (profile == null) {
    return null
  }

  // This codebase normalises an absent profile to 'default' (see
  // `profile || 'default'` in api/sessions.ts, api/client.ts, session-row.tsx),
  // so a blank or whitespace-only name is unresolved, not a profile called ''.
  const name = profile.trim()

  return name ? name : null
}

/**
 * True when both owners are known and genuinely different. An unknown side
 * returns false: the id comparison alone must keep its existing authority,
 * because a half-resolved pair is not evidence of a cross-profile switch.
 */
function isCrossProfileSwitch(state?: RouteProfileState): boolean {
  const routed = normaliseProfile(state?.routedProfile)
  const selected = normaliseProfile(state?.selectedProfile)

  return Boolean(routed && selected && routed !== selected)
}

/**
 * Whether the route points at a different conversation than the selected view.
 *
 * Auto-compression rotates a conversation from its root id to a continuation
 * tip while the durable URL intentionally stays on the root. Those ids are
 * different strings but still the same conversation, so a loaded lineage row
 * must win over the raw comparison. An unknown route remains a mismatch: that
 * is the real navigation case where the old transcript/composer must hide
 * until resume finishes.
 */
export function isRouteSessionMismatch(
  routedSessionId: null | string,
  selectedSessionId: null | string,
  sessions: readonly Pick<SessionInfo, '_lineage_root_id' | 'id'>[],
  activeTranscript?: ActiveTranscriptState,
  profileState?: RouteProfileState
): boolean {
  if (!routedSessionId) {
    return false
  }

  // Clicking a chat in another profile: the route can already carry the new
  // profile's session id while `selectedSessionId` is still the previous
  // profile's. Equal ids then mean "same conversation" only WITHIN one profile,
  // so the cross-profile case must blank the old transcript instead of keeping
  // it. Checked before the id comparison below, which would otherwise report
  // "no mismatch" and leave the previous profile's messages painted under the
  // new selection.
  if (isCrossProfileSwitch(profileState)) {
    return true
  }

  const matchesRoute = (storedSessionId: null | string) =>
    storedSessionId === routedSessionId ||
    Boolean(
      storedSessionId &&
      sessions.some(
        session => sessionMatchesStoredId(session, routedSessionId) && sessionMatchesStoredId(session, storedSessionId)
      )
    )

  // The selected view already owns the routed conversation: a profile or
  // connection switch must not blank it to the splash.
  if (matchesRoute(selectedSessionId)) {
    return false
  }

  // Only the transcript-retention fallback below must be denied while a
  // context switch is in flight; the prior context must not be retained.
  if (activeTranscript?.contextSwitching) {
    return true
  }

  return !(
    activeTranscript?.activeRuntimeId &&
    !activeTranscript.messagesEmpty &&
    matchesRoute(activeTranscript.transcriptStoredSessionId)
  )
}
