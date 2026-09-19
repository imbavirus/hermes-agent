/**
 * Union of every session that still has work in flight — LLM turns, blocked
 * input, `terminal(background=true)` processes, and mid-turn / post-turn
 * context compression ("Summarizing thread").
 *
 * Chrome focus / the selected chat / the active profile rail must not be the
 * keep-alive signal. Stream throttle, focus-reconnect, and the gateway
 * keep-set all read this so a job started in one chat keeps running after you
 * tab away, unfocus the window, or switch profiles.
 *
 * Compression is its own phase: `busy` can be false while the summarizer runs
 * (post-turn auto-compact, or a flicker between tool results and the next
 * API call). Leaving it out of this set re-throttles Chromium and drops the
 * gateway keep-set, so the continue after compact waits until that tab is
 * focused again.
 */

import { computed } from 'nanostores'

import { stableArray } from '@/lib/stable-array'

import { $compactingSessions } from './compaction'
import { $backgroundRunningSessionIds } from './composer-status'
import { $attentionSessionIds, $sessionStates, $workingSessionIds } from './session-states'

let liveWorkIds: readonly string[] = []

export const $liveWorkSessionIds = computed(
  [$workingSessionIds, $attentionSessionIds, $backgroundRunningSessionIds, $compactingSessions],
  (working, attention, background, compacting) => {
    const states = $sessionStates.get()

    const compactingStored = Object.keys(compacting)
      .filter(Boolean)
      .map(runtimeId => states[runtimeId]?.storedSessionId || runtimeId)

    return (liveWorkIds = stableArray(liveWorkIds, [
      ...new Set([...working, ...attention, ...background, ...compactingStored])
    ]))
  }
)
