/**
 * Browser-side polling of the suggestions route.
 *
 * The Host pushes no events to the browser half (third-party plugins have
 * no Typert Remote entry point), so the bar polls while the session exists.
 * Failures are silent: a dropped poll keeps the last set on screen — the
 * Host withdraws suggestions through `turn/start`, which the next
 * successful poll reflects, so a transient network error never blanks chips
 * the user is still reading.
 *
 * Route paths are written document-relative: the served index carries
 * `<base href="./">`, so the request lands on the same origin that served
 * the page — which is what carries the browser session cookie the route's
 * authentication fence requires.
 *
 * @module jev-suggest/client/suggest-api
 */

import type { SuggestionSet, SuggestionsResponse } from '../types.ts'

/** The suggestions route, document-relative (no leading slash). */
export const SUGGESTIONS_ROUTE = 'api/jev-suggest/suggestions'
/** The click route, document-relative. */
export const CLICK_ROUTE = 'api/jev-suggest/click'

/** Default poll interval; the chips are a convenience, not a live feed. */
export const DEFAULT_POLL_INTERVAL_MS = 2000

/** Options accepted by {@link startSuggestionPolling}. */
export interface PollOptions {
  /** The session to poll for; `undefined` idles the poller. */
  sessionId: string | undefined
  /** Poll interval in milliseconds. */
  intervalMs: number
  /** Called with the latest set on every successful poll; `null` while none is live. */
  onUpdate: (set: SuggestionSet | null) => void
  /** Fetch implementation; injectable for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch
}

/**
 * Start polling; returns the stop function. An absent session id keeps the
 * poller idle (no timer) rather than clearing the caller's state — the
 * caller owns the unmount case.
 */
export function startSuggestionPolling(options: PollOptions): () => void {
  const { sessionId, intervalMs, onUpdate } = options
  if (sessionId === undefined || sessionId === '') return () => {}
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  let timer: ReturnType<typeof setInterval> | undefined
  const poll = (): void => {
    void fetchImpl(`${SUGGESTIONS_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, { credentials: 'include' })
      .then(async response => {
        if (!response.ok) return
        const body = await response.json() as SuggestionsResponse
        if (body.ok) onUpdate(body.suggestions)
      })
      .catch(() => {})
  }
  poll()
  timer = setInterval(poll, intervalMs)
  return () => {
    if (timer !== undefined) clearInterval(timer)
  }
}

/** Report a chip click; fire-and-forget telemetry. */
export function reportClick(sessionId: string, generation: number, id: string, fetchImpl: typeof fetch = globalThis.fetch): void {
  void fetchImpl(CLICK_ROUTE, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, generation, id }),
  }).catch(() => {})
}
