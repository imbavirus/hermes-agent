/**
 * Union of every session that still has work in flight — LLM turns, blocked
 * input, and `terminal(background=true)` processes.
 *
 * Chrome focus / the selected chat / the active profile rail must not be the
 * keep-alive signal. Stream throttle, focus-reconnect, and the gateway
 * keep-set all read this so a job started in one chat keeps running after you
 * tab away, unfocus the window, or switch profiles.
 */

import { computed } from 'nanostores'

import { stableArray } from '@/lib/stable-array'

import { $backgroundRunningSessionIds } from './composer-status'
import { $attentionSessionIds, $workingSessionIds } from './session-states'

let liveWorkIds: readonly string[] = []

export const $liveWorkSessionIds = computed(
  [$workingSessionIds, $attentionSessionIds, $backgroundRunningSessionIds],
  (working, attention, background) =>
    (liveWorkIds = stableArray(liveWorkIds, [...new Set([...working, ...attention, ...background])]))
)
