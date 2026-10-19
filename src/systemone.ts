/**
 * Step 2 of the pipeline: score the generated candidates with the DashScope
 * `systemone` decision model over the choice protocol — one question, the candidates as `criteria`, the reply
 * a full probability distribution. This module is the protocol's minimal
 * client: no family gates, no defer margins, because a display wants the
 * whole distribution, not a selection.
 *
 * Error semantics: a missing key and
 * HTTP 401 throw {@link AuthenticationError} (configuration errors surface
 * once); every transport or protocol failure is an `error` outcome with a
 * reason, so the caller can fail closed and cool down.
 *
 * @module jev-suggest/systemone
 */

/** Thrown for the two credential-configuration failures: missing key and 401. */
export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthenticationError'
  }
}

/** One candidate as the scorer receives it. */
export interface ScoreCandidate {
  readonly id: string
  readonly label: string
}

/** Normalized scoring outcome. */
export type ScoreOutcome =
  | { kind: 'ok'; scores: ReadonlyMap<string, number> }
  | { kind: 'error'; reasons: string[] }

/** Options accepted by {@link scoreCandidates}. */
export interface SystemoneScoreOptions {
  /** Service base URL, e.g. `https://maas.qianwenaiapi.com/compatible-mode/v1`. */
  baseUrl: string
  /** Model id, e.g. `decision-model-preview`. */
  model: string
  /** API key resolver; the key never lands in config files or logs. */
  keyProvider: () => string | undefined
  /** Per-request timeout in milliseconds; 0 disables. */
  timeoutMs: number
  /** Fetch implementation; injectable for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch
}

/** The one question this client asks. */
const INSTRUCTIONS = 'Which action is the user most likely to take next?'
/** The question key in the request and the answer map. */
const QUESTION_KEY = 'action'

/** `systemone` response fields as the client reads them; read loosely. */
interface SystemoneResponse {
  model?: unknown
  request_id?: unknown
  usage?: unknown
  latency_ms?: unknown
  answers?: unknown
}

/** Ask the decision model for a probability distribution over the candidates. */
export async function scoreCandidates(
  options: SystemoneScoreOptions,
  state: string,
  candidates: readonly ScoreCandidate[],
  signal?: AbortSignal,
): Promise<ScoreOutcome> {
  const key = options.keyProvider()
  if (!key) throw new AuthenticationError('jev-suggest: systemone API key is missing (check the systemoneApiKeyEnv config)')
  const criteria: Record<string, string> = {}
  for (const candidate of candidates) criteria[candidate.id] = candidate.label

  const timeout = options.timeoutMs > 0 ? AbortSignal.timeout(options.timeoutMs) : undefined
  const fused = signal && timeout ? AbortSignal.any([signal, timeout]) : signal ?? timeout
  let response: Response
  try {
    response = await (options.fetchImpl ?? globalThis.fetch)(`${trimSlash(options.baseUrl)}/systemone`, {
      method: 'POST',
      headers: { Authorization: key, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        state: { content: state },
        questions: { [QUESTION_KEY]: { type: 'choice', instructions: INSTRUCTIONS, criteria } },
      }),
      signal: fused ?? null,
    })
  } catch {
    if (signal?.aborted) return { kind: 'error', reasons: ['aborted'] }
    return { kind: 'error', reasons: [fused?.aborted === true ? 'timeout' : 'network_error'] }
  }
  if (response.status === 401) throw new AuthenticationError('jev-suggest: systemone rejected the API key (HTTP 401)')
  if (response.status !== 200) return { kind: 'error', reasons: [httpReason(response.status)] }

  let raw: SystemoneResponse
  try {
    raw = await response.json() as SystemoneResponse
  } catch {
    return { kind: 'error', reasons: ['malformed_response'] }
  }
  if (typeof raw.model === 'string' && raw.model !== options.model) {
    return { kind: 'error', reasons: ['model_mismatch'] }
  }
  const answer = (raw.answers as Record<string, { probabilities?: unknown }> | undefined)?.[QUESTION_KEY]
  const probabilities = answer?.probabilities
  if (probabilities === undefined || probabilities === null || typeof probabilities !== 'object') {
    return { kind: 'error', reasons: ['malformed_response'] }
  }
  const scores = new Map<string, number>()
  for (const candidate of candidates) {
    const value = (probabilities as Record<string, unknown>)[candidate.id]
    if (typeof value === 'number' && Number.isFinite(value)) scores.set(candidate.id, value)
  }
  if (scores.size === 0) return { kind: 'error', reasons: ['no_known_scores'] }
  return { kind: 'ok', scores }
}

function httpReason(status: number): string {
  if (status === 429) return 'rate_limited'
  if (status === 503) return 'service_unavailable'
  if (status === 400) return 'bad_request'
  return `http_${status}`
}

function trimSlash(text: string): string {
  return text.replace(/\/+$/, '')
}
