import { describe, expect, it } from 'vitest'
import { AuthenticationError, scoreCandidates } from '../src/systemone.ts'

const baseOptions = {
  baseUrl: 'https://maas.example.com/compatible-mode/v1',
  model: 'decision-model-preview',
  keyProvider: () => 'test-key',
  timeoutMs: 5000,
}

const candidates = [
  { id: 'continue', label: 'continue the refactor' },
  { id: 'verify', label: 'run the tests' },
]

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function answer(probabilities: Record<string, number>, model = 'decision-model-preview') {
  return { model, request_id: 'r1', answers: { action: { type: 'choice', choice: 'continue', probabilities } } }
}

type Handler = (url: string, body: Record<string, unknown>) => Response

function makeFetcher(handler: Handler): { fetchImpl: typeof fetch; calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> } {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url: String(url), headers, body })
    return handler(String(url), body)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('systemone — request construction', () => {
  it('maps candidates to one action choice question with raw Authorization', async () => {
    const { fetchImpl, calls } = makeFetcher(() => jsonResponse(200, answer({ continue: 0.7, verify: 0.3 })))
    const outcome = await scoreCandidates({ ...baseOptions, fetchImpl }, 'the state', candidates)
    expect(outcome.kind).toBe('ok')
    expect(calls).toHaveLength(1)
    const { url, headers, body } = calls[0]!
    expect(url).toBe('https://maas.example.com/compatible-mode/v1/systemone')
    expect(headers['Authorization']).toBe('test-key')
    expect(body['model']).toBe('decision-model-preview')
    expect(body['state']).toEqual({ content: 'the state' })
    const question = (body['questions'] as Record<string, unknown>)['action'] as Record<string, unknown>
    expect(question['type']).toBe('choice')
    expect(question['criteria']).toEqual({
      continue: 'continue the refactor',
      verify: 'run the tests',
    })
  })
})

describe('systemone — outcomes', () => {
  it('returns the probability map for known ids', async () => {
    const { fetchImpl } = makeFetcher(() => jsonResponse(200, answer({ continue: 0.7, verify: 0.3 })))
    const outcome = await scoreCandidates({ ...baseOptions, fetchImpl }, 's', candidates)
    expect(outcome).toEqual({ kind: 'ok', scores: new Map([['continue', 0.7], ['verify', 0.3]]) })
  })

  it('ignores hallucinated ids but keeps the known ones', async () => {
    const { fetchImpl } = makeFetcher(() => jsonResponse(200, answer({ continue: 0.5, hallucinated: 0.5 })))
    const outcome = await scoreCandidates({ ...baseOptions, fetchImpl }, 's', candidates)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.scores.has('verify')).toBe(false)
      expect(outcome.scores.get('continue')).toBe(0.5)
    }
  })

  it('denies with no_known_scores when nothing matches', async () => {
    const { fetchImpl } = makeFetcher(() => jsonResponse(200, answer({ other: 1 })))
    const outcome = await scoreCandidates({ ...baseOptions, fetchImpl }, 's', candidates)
    expect(outcome).toEqual({ kind: 'error', reasons: ['no_known_scores'] })
  })
})

describe('systemone — failures', () => {
  it('throws for a missing key', async () => {
    const { fetchImpl } = makeFetcher(() => jsonResponse(200, answer({})))
    await expect(scoreCandidates({ ...baseOptions, keyProvider: () => undefined, fetchImpl }, 's', candidates))
      .rejects.toBeInstanceOf(AuthenticationError)
  })

  it('throws for HTTP 401', async () => {
    const { fetchImpl } = makeFetcher(() => jsonResponse(401, {}))
    await expect(scoreCandidates({ ...baseOptions, fetchImpl }, 's', candidates))
      .rejects.toBeInstanceOf(AuthenticationError)
  })

  it('denies with the mapped reason for other statuses', async () => {
    const { fetchImpl } = makeFetcher(() => jsonResponse(429, {}))
    expect(await scoreCandidates({ ...baseOptions, fetchImpl }, 's', candidates)).toEqual({ kind: 'error', reasons: ['rate_limited'] })
  })

  it('denies with malformed_response for a broken body', async () => {
    const failing = (async () => new Response('{broken', { status: 200 })) as unknown as typeof fetch
    expect(await scoreCandidates({ ...baseOptions, fetchImpl: failing }, 's', candidates)).toEqual({ kind: 'error', reasons: ['malformed_response'] })
  })

  it('denies with malformed_response when probabilities are absent', async () => {
    const { fetchImpl } = makeFetcher(() => jsonResponse(200, { model: 'decision-model-preview', answers: { action: {} } }))
    expect(await scoreCandidates({ ...baseOptions, fetchImpl }, 's', candidates)).toEqual({ kind: 'error', reasons: ['malformed_response'] })
  })

  it('denies with model_mismatch when the echo differs', async () => {
    const { fetchImpl } = makeFetcher(() => jsonResponse(200, answer({ continue: 1 }, 'other-model')))
    expect(await scoreCandidates({ ...baseOptions, fetchImpl }, 's', candidates)).toEqual({ kind: 'error', reasons: ['model_mismatch'] })
  })

  it('denies with timeout when the deadline fires', async () => {
    const hanging = (async (_url: string | URL | Request, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal?.aborted) { reject(signal.reason); return }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }) as unknown as typeof fetch
    expect(await scoreCandidates({ ...baseOptions, timeoutMs: 20, fetchImpl: hanging }, 's', candidates))
      .toEqual({ kind: 'error', reasons: ['timeout'] })
  })

  it('denies with aborted when the caller cancels', async () => {
    const controller = new AbortController()
    const hanging = (async (_url: string | URL | Request, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal?.aborted) { reject(signal.reason); return }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        controller.abort()
      })
    }) as unknown as typeof fetch
    expect(await scoreCandidates({ ...baseOptions, timeoutMs: 0, fetchImpl: hanging }, 's', candidates, controller.signal))
      .toEqual({ kind: 'error', reasons: ['aborted'] })
  })
})
