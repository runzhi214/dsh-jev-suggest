/**
 * jev-suggest — next-action suggestions for DSH conversations.
 *
 * After every completed turn, a two-step pipeline runs: one ordinary LLM
 * call (through `ctx.llm`, the service the conversation itself uses)
 * generates the candidate actions, and the DashScope `systemone` decision
 * model scores them into a calibrated probability distribution. `on` mode
 * publishes the set to the browser-facing routes, where the client half
 * renders it as clickable chips above the composer; `shadow` mode computes
 * and logs without publishing. A new turn withdraws the set and aborts any
 * in-flight computation, so chips never outlive the turn they describe.
 *
 * Privacy: the goal and the latest reply travel to the generation model and
 * the scorer — the same surfaces that already saw them as the conversation's
 * own inputs and outputs. The observer log records only ids, probabilities,
 * reasons, and timings.
 *
 * @module jev-suggest
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.llm merge (the adapter registry + stream API).
import type {} from '@deepseek-ai/dsh-llm'
// Type-only: pulls the ctx.connection merge (the authenticated fetch registry).
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: pulls the session/* event typings into scope.
import type {} from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { createJsonlWriter } from './jsonl.ts'
import { createSuggestionPipeline, type PluginMode } from './pipeline.ts'
import { scoreCandidates } from './systemone.ts'
import { extractText, SuggestTracker } from './state.ts'
import { CLICK_PATH, createSuggestRoutes, SUGGESTIONS_PATH } from './routes.ts'

/** Plugin config; defaults are the doc/01 decision values. */
export interface Config {
  /** `off` (default) / `shadow` / `on`. `JEV_SUGGEST_MODE` env overrides per turn. */
  readonly mode: PluginMode
  /** Fixed provider for the generation call; empty = the session's observed route. */
  readonly provider: string
  /** Fixed model for the generation call; empty = the session's observed route. */
  readonly model: string
  /** systemone service base URL. */
  readonly systemoneBaseUrl: string
  /** systemone model id. */
  readonly systemoneModel: string
  /** Which env var holds the systemone API key. The key never enters config or logs. */
  readonly systemoneApiKeyEnv: string
  /** Candidate count cap for both the prompt and the published set. */
  readonly maxSuggestions: number
  /** Items below this probability are not published. */
  readonly minDisplayProbability: number
  /** Wall-clock budget for the generation call. */
  readonly generationTimeoutMs: number
  /** systemone per-request timeout. */
  readonly systemoneTimeoutMs: number
  /** Skip recomputation while the (goal, reply) state key is unchanged. */
  readonly stateTtlMs: number
  /** Consecutive upstream failures before the cooldown engages. */
  readonly failureThreshold: number
  /** Cooldown window that skips the upstream entirely. */
  readonly failureCooldownMs: number
  /** JSONL observer log; empty disables logging. */
  readonly logPath: string
}

/** Runtime schema: defaults and validation at plugin load. */
export const Config = z.object({
  mode: z.union(['off', 'shadow', 'on']).default('off'),
  provider: z.string().default(''),
  model: z.string().default(''),
  systemoneBaseUrl: z.string().default('https://maas.qianwenaiapi.com/compatible-mode/v1'),
  systemoneModel: z.string().default('decision-model-preview'),
  systemoneApiKeyEnv: z.string().default('DASHSCOPE_API_KEY'),
  maxSuggestions: z.number().min(1).max(10).default(5),
  minDisplayProbability: z.number().min(0).max(1).default(0.05),
  generationTimeoutMs: z.number().min(100).max(120_000).default(20_000),
  systemoneTimeoutMs: z.number().min(100).max(90_000).default(3000),
  stateTtlMs: z.number().min(0).max(600_000).default(5000),
  failureThreshold: z.number().min(1).max(100).default(3),
  failureCooldownMs: z.number().min(0).max(3_600_000).default(60_000),
  logPath: z.string().default(''),
})

export const name = 'jev-suggest'
export const inject = ['llm', 'connection']

/** Version stamped into the era marker; keep in sync with package.json. */
const PLUGIN_VERSION = '0.0.1-beta.5'

/** Env override for the mode. */
const MODE_ENV = 'JEV_SUGGEST_MODE'

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('jev-suggest')
  const tracker = new SuggestTracker()
  const log = createJsonlWriter(config.logPath, { warn: message => logger.warn(message) })
  // Era marker: every load records the version
  // and gate parameters, so log analysis attributes events to an exact
  // parameter generation without content sniffing.
  log?.append({
    t: 'plugin_start',
    version: PLUGIN_VERSION,
    mode: config.mode,
    maxSuggestions: config.maxSuggestions,
    minDisplayProbability: config.minDisplayProbability,
    stateTtlMs: config.stateTtlMs,
    failureThreshold: config.failureThreshold,
    failureCooldownMs: config.failureCooldownMs,
  })

  const pipeline = createSuggestionPipeline({
    tracker,
    llm: ctx.llm,
    scorer: (state, candidates, signal) =>
      scoreCandidates(
        {
          baseUrl: config.systemoneBaseUrl,
          model: config.systemoneModel,
          keyProvider: () => process.env[config.systemoneApiKeyEnv],
          timeoutMs: config.systemoneTimeoutMs,
        },
        state,
        candidates,
        signal,
      ),
    // The session's own requestContext fold — resume-safe: `request/context`
    // events only log on route changes, so a continued conversation re-emits
    // nothing and event tracking alone starves (the 2026-10-12 no_provider).
    resolveRoute: session => routeOfSession(session),
    log,
    logger,
    resolveConfig: () => {
      const envMode = process.env[MODE_ENV]
      const mode = envMode === undefined || envMode === '' ? config.mode : envMode
      if (mode !== 'off' && mode !== 'shadow' && mode !== 'on') return null
      return {
        mode,
        provider: config.provider,
        model: config.model,
        maxSuggestions: config.maxSuggestions,
        minDisplayProbability: config.minDisplayProbability,
        generationTimeoutMs: config.generationTimeoutMs,
        stateTtlMs: config.stateTtlMs,
        failureThreshold: config.failureThreshold,
        failureCooldownMs: config.failureCooldownMs,
      }
    },
    now: () => Date.now(),
  })

  ctx.effect(() =>
    ctx.on('session/created', function (session) {
      tracker.recordSessionId(session, sessionIdOf(session))
    }),
  )
  ctx.effect(() =>
    ctx.on('session/event', function (session, event) {
      tracker.recordSessionId(session, sessionIdOf(session))
      switch (event.type) {
        case 'user/message':
          if (event.data.source.kind === 'user') tracker.recordGoal(session, extractText(event.data.content))
          break
        case 'assistant/message':
          tracker.recordReply(session, event.data.turn, extractText(event.data.message.content))
          break
        case 'request/context':
          tracker.recordRoute(session, event.data.provider, event.data.model)
          break
        case 'turn/start':
          pipeline.onTurnStart(session)
          break
        case 'turn/end':
          pipeline.onTurnEnd(session, event.data.reason)
          break
      }
    }),
  )
  ctx.effect(() =>
    ctx.on('session/disposed', function (session) {
      pipeline.onSessionDisposed(session)
    }),
  )

  const routes = createSuggestRoutes({ tracker, log })
  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: SUGGESTIONS_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: routes.getSuggestions,
    }), 'jev-suggest: suggestions route')
  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: CLICK_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: routes.postClick,
    }), 'jev-suggest: click route')

  logger.info(`jev-suggest: mode ${config.mode}, scorer ${config.systemoneModel}`)
}

/** The full session id a host session object carries; `undefined` without one. */
function sessionIdOf(session: object): string | undefined {
  const id = (session as { id?: unknown }).id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** The session's folded route metadata, read loosely; `undefined` without any. */
function routeOfSession(session: object): { provider: string; model: string } | undefined {
  const folded = (session as { requestContext?: () => unknown }).requestContext?.()
  if (folded === undefined || folded === null || typeof folded !== 'object') return undefined
  const { provider, model } = folded as { provider?: unknown; model?: unknown }
  if (typeof provider !== 'string' || provider === '') return undefined
  if (typeof model !== 'string' || model === '') return undefined
  return { provider, model }
}
