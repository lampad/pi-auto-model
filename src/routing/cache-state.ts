import type { SessionRuntimeState } from "../types.ts";

/** Common provider prompt-cache lifetime (Anthropic's default TTL); idle sessions beyond it start cold. */
export const CACHE_IDLE_MS = 5 * 60_000;

/** Why the current target's prompt cache can no longer be reused, or undefined while it is likely warm. */
export function coldCacheReason(
	state: Pick<SessionRuntimeState, "cacheBoundary" | "lastTaskEndedAt">,
	now = Date.now(),
): string | undefined {
	if (state.cacheBoundary) return state.cacheBoundary.reason;
	if (state.lastTaskEndedAt !== undefined && now - state.lastTaskEndedAt > CACHE_IDLE_MS) {
		return `idle ${Math.floor((now - state.lastTaskEndedAt) / 60_000)}m`;
	}
	return undefined;
}
