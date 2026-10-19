/**
 * The two-step suggestion pipeline and its guards.
 *
 * On every `turn/end` with reason `completed`: resolve the model route,
 * generate candidates (`generate.ts`), score them (`systemone.ts`), filter
 * by display thresholds, and publish. Every guard that declines — mode off,
 * no context, TTL dedup, cooldown — skips silently; real failures count
 * toward the cooldown and land in the observer log. `turn/start` aborts an
 * in-flight computation and withdraws the published set, so chips never
 * outlive the turn they describe.
 *
 * `shadow` computes and logs but never publishes: observation before action.
 *
 * @module jev-suggest/pipeline
 */

import type { SessionFacts, SuggestTracker } from './state.ts'
import { stateKeyOf } from './state.ts'
import { generateCandidates, type Candidate, type LlmStreamPort } from './generate.ts'
import type { ScoreOutcome } from './systemone.ts'
import type { JsonlWriter } from './jsonl.ts'
import type { SuggestionItem } from './types.ts'

/** Plugin mode: `off` does nothing, `shadow` observes, `on` publishes. */
export type PluginMode = 'off' | 'shadow' | 'on'

/** The config slice the pipeline reads per turn. */
export interface EffectiveConfig {
  readonly mode: PluginMode
  /** Fixed provider for the generation call; empty = use the session's route. */
  readonly provider: string
  /** Fixed model for the generation call; empty = use the session's route. */
  readonly model: string
  readonly maxSuggestions: number
  readonly minDisplayProbability: number
  readonly generationTimeoutMs: number
  readonly stateTtlMs: number
  readonly failureThreshold: number
  readonly failureCooldownMs: number
}

/** The scorer port; `scoreCandidates` satisfies it. */
export type Scorer = (
  state: string,
  candidates: readonly Candidate[],
  signal: AbortSignal | undefined,
) => Promise<ScoreOutcome>

/**
 * Route resolver over the session's own `requestContext()` fold. The
 * `request/context` event only logs on route CHANGES, so a resumed session
 * re-emits nothing and event tracking alone starves — the fold covers the
 * whole log, inherited prefix included.
 */
export type RouteResolver = (session: object) => { provider: string; model: string } | undefined

/** Logger port the pipeline needs (cordis loggers satisfy it). */
export interface PipelineLogger {
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** Options accepted by {@link createSuggestionPipeline}. */
export interface PipelineOptions {
  tracker: SuggestTracker
  llm: LlmStreamPort
  scorer: Scorer
  /** Session-log route fold; the resume-safe provider/model source. */
  resolveRoute: RouteResolver
  log: JsonlWriter | null
  logger: PipelineLogger
  resolveConfig: () => EffectiveConfig | null
  now: () => number
}

/** One in-flight computation's dedup record. */
interface ComputedKey {
  key: string
  at: number
}

/** Compose the state string the scorer receives: goal plus the reply. */
function composeState(facts: SessionFacts): string {
  return [`User request: ${facts.goal}`, '', `Assistant's latest reply: ${facts.lastAssistant}`].join('\n')
}

/** Assemble the pipeline handlers the host entry wires to session events. */
export function createSuggestionPipeline(options: PipelineOptions) {
  const inFlight = new WeakMap<object, AbortController>()
  const computed = new WeakMap<object, ComputedKey>()
  let failures = 0
  let cooldownUntil = 0

  /** A new turn opened: abort any in-flight work and withdraw the chips. */
  function onTurnStart(session: object): void {
    inFlight.get(session)?.abort()
    options.tracker.withdraw(session)
  }

  /** A turn closed: run the pipeline when the reason is a clean completion. */
  function onTurnEnd(session: object, reason: { kind: string }): void {
    if (reason.kind !== 'completed') return
    const config = options.resolveConfig()
    if (config === null || config.mode === 'off') return
    void compute(session, config).catch(error => {
      options.logger.error(`jev-suggest: pipeline failed: ${String(error)}`)
    })
  }

  /** A session left the store: drop its published set. */
  function onSessionDisposed(session: object): void {
    const fullId = options.tracker.factsFor(session)?.fullId
    if (fullId !== undefined) options.tracker.dispose(fullId)
  }

  async function compute(session: object, config: EffectiveConfig): Promise<void> {
    const facts = options.tracker.factsFor(session)
    if (facts === undefined) return
    const sid = facts.sid ?? null
    if (facts.goal === '' || facts.lastAssistant === '') {
      options.log?.append({ t: 'suggest_skipped', sid, reason: 'no_context' })
      return
    }
    const provider = config.provider !== '' ? config.provider : resolveProvider(facts, options.resolveRoute(session))
    const model = config.model !== '' ? config.model : resolveModel(facts, options.resolveRoute(session))
    if (provider === '' || model === '') {
      options.log?.append({ t: 'suggest_error', sid, reason: 'no_provider' })
      return
    }
    if (options.now() < cooldownUntil) {
      options.log?.append({ t: 'suggest_skipped', sid, reason: 'cooldown' })
      return
    }
    const key = stateKeyOf(facts)
    const previous = computed.get(session)
    if (previous !== undefined && previous.key === key && options.now() - previous.at < config.stateTtlMs) {
      options.log?.append({ t: 'suggest_skipped', sid, reason: 'ttl_dedup' })
      return
    }

    const controller = new AbortController()
    inFlight.set(session, controller)
    const startedAt = options.now()
    try {
      const timeout = config.generationTimeoutMs > 0 ? AbortSignal.timeout(config.generationTimeoutMs) : undefined
      const fused = timeout === undefined ? controller.signal : AbortSignal.any([controller.signal, timeout])
      const generated = await generateCandidates(options.llm, {
        provider, model, goal: facts.goal, reply: facts.lastAssistant,
        maxSuggestions: config.maxSuggestions, signal: fused,
      })
      if (generated.kind === 'error') {
        recordFailure(config, { t: 'suggest_error', sid, reason: generated.reason, stage: 'generate' })
        return
      }
      const scored = await options.scorer(composeState(facts), generated.candidates, controller.signal)
      if (scored.kind === 'error') {
        recordFailure(config, { t: 'suggest_error', sid, reasons: scored.reasons.join(','), stage: 'score' })
        return
      }
      const items: SuggestionItem[] = generated.candidates
        .map(candidate => ({ ...candidate, probability: scored.scores.get(candidate.id) ?? 0 }))
        .filter(item => item.probability >= config.minDisplayProbability)
        .sort((a, b) => b.probability - a.probability)
        .slice(0, config.maxSuggestions)
      if (items.length === 0) {
        options.log?.append({ t: 'suggest_skipped', sid, reason: 'below_display_threshold' })
        computed.set(session, { key, at: options.now() })
        return
      }
      const turn = facts.turn
      if (config.mode === 'on' && options.tracker.publish(session, { turn, items }) === null) {
        options.log?.append({ t: 'suggest_skipped', sid, reason: 'no_session_id' })
        return
      }
      failures = 0
      computed.set(session, { key, at: options.now() })
      options.log?.append({
        t: 'suggest_computed', sid, turn, mode: config.mode,
        count: items.length, elapsed_ms: options.now() - startedAt,
        items: items.map(item => ({ id: item.id, p: round3(item.probability) })),
      })
    } finally {
      if (inFlight.get(session) === controller) inFlight.delete(session)
    }
  }

  /** Count a failure toward the cooldown and log it. */
  function recordFailure(config: EffectiveConfig, event: Record<string, unknown>): void {
    failures += 1
    if (failures >= config.failureThreshold) {
      cooldownUntil = options.now() + config.failureCooldownMs
      failures = 0
      options.logger.warn('jev-suggest: upstream failures engaged the cooldown')
    }
    options.log?.append(event)
  }

  return { onTurnStart, onTurnEnd, onSessionDisposed }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** Config aside, the live facts win, then the session-log fold (resume cover). */
function resolveProvider(facts: SessionFacts, folded: { provider: string; model: string } | undefined): string {
  if (facts.provider !== '') return facts.provider
  return folded?.provider ?? ''
}

/** Config aside, the live facts win, then the session-log fold (resume cover). */
function resolveModel(facts: SessionFacts, folded: { provider: string; model: string } | undefined): string {
  if (facts.model !== '') return facts.model
  return folded?.model ?? ''
}
