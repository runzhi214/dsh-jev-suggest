/**
 * Wire-shared types: what the Host publishes and what the browser half and
 * the routes exchange. Kept free of Node imports so the client bundle can
 * inline this module.
 *
 * @module jev-suggest/types
 */

/** One suggested next action as the UI receives it. */
export interface SuggestionItem {
  /** Stable id: the candidate id the generation step produced. */
  readonly id: string
  /** A short imperative sentence, directly usable as the user's next message. */
  readonly label: string
  /** Calibrated probability from the decision model; 0..1. */
  readonly probability: number
}

/** One turn's published suggestions; `generation` keys click staleness. */
export interface SuggestionSet {
  /** Bumped on every publish; a click citing an older generation is stale. */
  readonly generation: number
  /** The turn the suggestions were computed from. */
  readonly turn: number
  readonly items: readonly SuggestionItem[]
}

/** GET response of the suggestions route. */
export interface SuggestionsResponse {
  readonly ok: boolean
  /** The latest published set for the session; `null` while none is live. */
  readonly suggestions: SuggestionSet | null
}

/** POST response of the click route. */
export interface ClickResponse {
  readonly ok: boolean
  /** True when the click cited a generation older than the published one. */
  readonly stale?: boolean
}
