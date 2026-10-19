import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_POLL_INTERVAL_MS, reportClick, startSuggestionPolling } from '../src/client/suggest-api.ts'
import type { SuggestionSet, SuggestionsResponse } from '../src/types.ts'

const setOf = (generation: number): SuggestionSet => ({
  generation,
  turn: 1,
  items: [{ id: 'continue', label: 'continue', probability: 0.6 }],
})

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>

function makeFetcher(handler: Handler): { fetchImpl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const entry = { url: String(url), init }
    calls.push(entry)
    return handler(entry.url, init)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('suggest-api — polling', () => {
  it('polls immediately and then on the interval', async () => {
    const { fetchImpl, calls } = makeFetcher(() => Response.json({ ok: true, suggestions: setOf(1) } satisfies SuggestionsResponse))
    const updates: Array<SuggestionSet | null> = []
    startSuggestionPolling({ sessionId: 's1', intervalMs: DEFAULT_POLL_INTERVAL_MS, onUpdate: set => updates.push(set), fetchImpl })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(4000)
    expect(calls).toHaveLength(4)
    expect(updates.every(update => update?.generation === 1)).toBe(true)
  })

  it('queries the route document-relatively with the encoded session id', async () => {
    const { fetchImpl, calls } = makeFetcher(() => Response.json({ ok: true, suggestions: null } satisfies SuggestionsResponse))
    startSuggestionPolling({ sessionId: 'id with spaces', intervalMs: 1000, onUpdate: () => {}, fetchImpl })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls[0]!.url).toBe('api/jev-suggest/suggestions?sessionId=id%20with%20spaces')
    expect(calls[0]!.init?.credentials).toBe('include')
  })

  it('stays idle without a session id', async () => {
    const { fetchImpl, calls } = makeFetcher(() => Response.json({ ok: true, suggestions: null }))
    const stop = startSuggestionPolling({ sessionId: undefined, intervalMs: 1000, onUpdate: () => {}, fetchImpl })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toHaveLength(0)
    stop()
  })

  it('keeps the last update through fetch failures and non-ok responses', async () => {
    let ok = true
    let generation = 1
    const { fetchImpl } = makeFetcher(() => {
      if (!ok) return new Response('nope', { status: 500 })
      return Response.json({ ok: true, suggestions: setOf(generation) } satisfies SuggestionsResponse)
    })
    const updates: Array<SuggestionSet | null> = []
    startSuggestionPolling({ sessionId: 's1', intervalMs: 1000, onUpdate: set => updates.push(set), fetchImpl })
    await vi.advanceTimersByTimeAsync(0)
    ok = false
    generation = 2
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(updates).toHaveLength(1)
  })

  it('forwards a null set when none is published', async () => {
    const { fetchImpl } = makeFetcher(() => Response.json({ ok: true, suggestions: null } satisfies SuggestionsResponse))
    const updates: Array<SuggestionSet | null> = []
    startSuggestionPolling({ sessionId: 's1', intervalMs: 1000, onUpdate: set => updates.push(set), fetchImpl })
    await vi.advanceTimersByTimeAsync(0)
    expect(updates).toEqual([null])
  })

  it('stops polling after the disposer runs', async () => {
    const { fetchImpl, calls } = makeFetcher(() => Response.json({ ok: true, suggestions: null }))
    const stop = startSuggestionPolling({ sessionId: 's1', intervalMs: 1000, onUpdate: () => {}, fetchImpl })
    await vi.advanceTimersByTimeAsync(0)
    stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toHaveLength(1)
  })
})

describe('suggest-api — click reporting', () => {
  it('POSTs the click with credentials and the generation', async () => {
    const { fetchImpl, calls } = makeFetcher(() => Response.json({ ok: true }))
    reportClick('s1', 3, 'continue', fetchImpl)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('api/jev-suggest/click')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.init?.credentials).toBe('include')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ sessionId: 's1', generation: 3, id: 'continue' })
  })

  it('swallows transport failures', async () => {
    const fetchImpl = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    reportClick('s1', 3, 'continue', fetchImpl)
    await vi.advanceTimersByTimeAsync(0)
  })
})
