/**
 * Per-session facts and the published-suggestion store.
 *
 * Two stores with two lifetimes: collectors feed one `WeakMap` keyed by the session object (state dies with
 * the session, never enters the durable log), while the published sets live
 * in a plain `Map` keyed by the full session id — that is what the browser
 * route queries, so it must survive without a session reference.
 *
 * Privacy split: the observer log receives only the short hashed `sid`;
 * the full session id never leaves the Host↔browser channel, which already
 * knows it (the browser is chatting in that session).
 *
 * @module jev-suggest/state
 */

import { createHash } from 'node:crypto'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SuggestionSet } from './types.ts'

/** Goal text cap. */
export const GOAL_MAX_CHARS = 1800
/** Latest assistant reply cap sent to the generation prompt. */
export const REPLY_MAX_CHARS = 2800

/** Everything the pipeline knows about one session. */
export interface SessionFacts {
  /** Short observer-log id; absent until the host reveals a session id. */
  sid: string | undefined
  /** Full session id; the published-set key. Absent until revealed. */
  fullId: string | undefined
  goal: string
  lastAssistant: string
  /** Provider/model observed from `request/context`; empty until seen. */
  provider: string
  model: string
  /** The turn the latest assistant reply belongs to. */
  turn: number
}

/** Session-keyed facts plus the id-keyed published-suggestion store. */
export class SuggestTracker {
  private readonly facts = new WeakMap<object, SessionFacts>()
  private readonly published = new Map<string, SuggestionSet>()
  private readonly sids = new Map<string, string>()
  private generation = 0

  /** The tracked facts for a session, if any observation created it. */
  factsFor(session: object | undefined): SessionFacts | undefined {
    return session === undefined ? undefined : this.facts.get(session)
  }

  /** Record the session identity; the short hash and the full id travel together. */
  recordSessionId(session: object, id: string | undefined): void {
    if (id === undefined || id === '') return
    const facts = this.ensure(session)
    const sid = createHash('sha256').update(id).digest('hex').slice(0, 8)
    facts.fullId = id
    facts.sid = sid
    this.sids.set(id, sid)
  }

  /** Set the goal from one user message (truncated to {@link GOAL_MAX_CHARS}). */
  recordGoal(session: object, text: string): void {
    this.ensure(session).goal = truncate(text, GOAL_MAX_CHARS)
  }

  /** Fold one assistant reply in as the latest (truncated to {@link REPLY_MAX_CHARS}). */
  recordReply(session: object, turn: number, text: string): void {
    const facts = this.ensure(session)
    facts.lastAssistant = truncate(text, REPLY_MAX_CHARS)
    facts.turn = turn
  }

  /** Record the session's model route for the generation call. */
  recordRoute(session: object, provider: string, model: string): void {
    const facts = this.ensure(session)
    facts.provider = provider
    facts.model = model
  }

  /** Publish a suggestion set for a session; the generation counter keys staleness. */
  publish(session: object, set: Omit<SuggestionSet, 'generation'>): SuggestionSet | null {
    const facts = this.facts.get(session)
    if (facts?.fullId === undefined) return null
    this.generation += 1
    const full: SuggestionSet = { generation: this.generation, ...set }
    this.published.set(facts.fullId, full)
    return full
  }

  /** Withdraw the published set (a new turn started); no-op without one. */
  withdraw(session: object): void {
    const fullId = this.facts.get(session)?.fullId
    if (fullId !== undefined) this.published.delete(fullId)
  }

  /** Drop the published set of a disposed session by full id. */
  dispose(fullId: string): void {
    this.published.delete(fullId)
    this.sids.delete(fullId)
  }

  /** The published set for a full session id; `null` while none is live. */
  getPublished(fullId: string): SuggestionSet | null {
    return this.published.get(fullId) ?? null
  }

  /** The short observer-log id for a full session id, when known. */
  sidFor(fullId: string): string | undefined {
    return this.sids.get(fullId)
  }

  private ensure(session: object): SessionFacts {
    let state = this.facts.get(session)
    if (state === undefined) {
      state = { sid: undefined, fullId: undefined, goal: '', lastAssistant: '', provider: '', model: '', turn: 0 }
      this.facts.set(session, state)
    }
    return state
  }
}

/** The pipeline's dedup key: the two inputs that shape the suggestions. */
export function stateKeyOf(facts: SessionFacts): string {
  return JSON.stringify([facts.goal, facts.lastAssistant])
}

/** Join the text blocks of one message's content; other blocks are skipped. */
export function extractText(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}
