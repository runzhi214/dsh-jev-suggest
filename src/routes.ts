/**
 * The browser-facing routes, as pure handlers plus the registration shapes
 * the host entry wires into `ctx.connection.fetch`.
 *
 * GET `/api/jev-suggest/suggestions?sessionId=…` — the published set
 * for a session, or `null` while none is live. The browser polls this while
 * the session is idle.
 *
 * POST `/api/jev-suggest/click` — click telemetry. A click citing an
 * older generation is recorded but flagged `stale`, so a chip pressed as the
 * turn opens still counts as feedback without masquerading as current.
 *
 * @module jev-suggest/routes
 */

import type { JsonlWriter } from './jsonl.ts'
import type { SuggestTracker } from './state.ts'
import type { ClickResponse, SuggestionsResponse } from './types.ts'

/** Host route paths; must start with `/api` (the connection fence). */
export const SUGGESTIONS_PATH = '/api/jev-suggest/suggestions'
export const CLICK_PATH = '/api/jev-suggest/click'

/** The route handlers; each is a standard Fetch `Request` → `Response`. */
export interface SuggestRoutes {
  getSuggestions(request: Request): Promise<Response>
  postClick(request: Request): Promise<Response>
}

/** Dependencies the handlers read. */
export interface SuggestRoutesDeps {
  tracker: SuggestTracker
  log: JsonlWriter | null
}

/** Build the handlers; no framework state beyond the deps. */
export function createSuggestRoutes(deps: SuggestRoutesDeps): SuggestRoutes {
  return {
    async getSuggestions(request: Request): Promise<Response> {
      const sessionId = new URL(request.url).searchParams.get('sessionId')
      if (sessionId === null || sessionId === '') {
        return Response.json({ ok: false, error: 'sessionId is required' }, { status: 400 })
      }
      const suggestions = deps.tracker.getPublished(sessionId)
      return Response.json({ ok: true, suggestions } satisfies SuggestionsResponse)
    },

    async postClick(request: Request): Promise<Response> {
      let body: { sessionId?: unknown; generation?: unknown; id?: unknown }
      try {
        body = await request.json() as typeof body
      } catch {
        return Response.json({ ok: false } satisfies ClickResponse, { status: 400 })
      }
      const sessionId = body.sessionId
      const generation = body.generation
      const id = body.id
      if (typeof sessionId !== 'string' || sessionId === '' || typeof generation !== 'number' || typeof id !== 'string' || id === '') {
        return Response.json({ ok: false } satisfies ClickResponse, { status: 400 })
      }
      const published = deps.tracker.getPublished(sessionId)
      const stale = published === null || published.generation !== generation
      deps.log?.append({
        t: 'suggest_click',
        sid: deps.tracker.sidFor(sessionId) ?? null,
        id,
        stale,
      })
      return Response.json({ ok: true, ...(stale ? { stale: true } : {}) } satisfies ClickResponse)
    },
  }
}
