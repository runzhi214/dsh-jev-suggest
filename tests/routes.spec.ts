import { describe, expect, it } from 'vitest'
import { createSuggestRoutes } from '../src/routes.ts'
import type { JsonlWriter } from '../src/jsonl.ts'
import { SuggestTracker } from '../src/state.ts'

function memoryLog(): JsonlWriter & { events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = []
  return { events, append: event => { events.push({ ...event }) } }
}

function makeRoutes() {
  const tracker = new SuggestTracker()
  const session = {}
  tracker.recordSessionId(session, 'session-1')
  tracker.publish(session, { turn: 1, items: [{ id: 'continue', label: 'continue', probability: 0.6 }] })
  const log = memoryLog()
  return { routes: createSuggestRoutes({ tracker, log }), log, tracker, session }
}

function getRequest(path: string): Request {
  return new Request(`https://host${path}`)
}

function postRequest(path: string, body: unknown): Request {
  return new Request(`https://host${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('routes — GET suggestions', () => {
  it('answers the published set for a known session', async () => {
    const { routes } = makeRoutes()
    const response = await routes.getSuggestions(getRequest('/api/jev-suggest/suggestions?sessionId=session-1'))
    expect(response.status).toBe(200)
    const body = await response.json() as { ok: boolean; suggestions: { generation: number } | null }
    expect(body.ok).toBe(true)
    expect(body.suggestions!.generation).toBe(1)
  })

  it('answers null for an unknown session', async () => {
    const { routes } = makeRoutes()
    const response = await routes.getSuggestions(getRequest('/api/jev-suggest/suggestions?sessionId=nope'))
    const body = await response.json() as { ok: boolean; suggestions: null }
    expect(body).toEqual({ ok: true, suggestions: null })
  })

  it('rejects a missing sessionId with 400', async () => {
    const { routes } = makeRoutes()
    const response = await routes.getSuggestions(getRequest('/api/jev-suggest/suggestions'))
    expect(response.status).toBe(400)
    const body = await response.json() as { ok: boolean }
    expect(body.ok).toBe(false)
  })
})

describe('routes — POST click', () => {
  it('records a click on the current generation as fresh', async () => {
    const { routes, log } = makeRoutes()
    const response = await routes.postClick(postRequest('/api/jev-suggest/click', {
      sessionId: 'session-1', generation: 1, id: 'continue',
    }))
    expect(response.status).toBe(200)
    const body = await response.json() as { ok: boolean; stale?: boolean }
    expect(body).toEqual({ ok: true })
    expect(log.events).toHaveLength(1)
    expect(log.events[0]).toMatchObject({ t: 'suggest_click', id: 'continue', stale: false })
    expect(log.events[0]!['sid']).toMatch(/^[0-9a-f]{8}$/)
  })

  it('flags a click on an older generation as stale', async () => {
    const { routes, log } = makeRoutes()
    const response = await routes.postClick(postRequest('/api/jev-suggest/click', {
      sessionId: 'session-1', generation: 0, id: 'continue',
    }))
    const body = await response.json() as { ok: boolean; stale?: boolean }
    expect(body).toEqual({ ok: true, stale: true })
    expect(log.events[0]).toMatchObject({ stale: true })
  })

  it('flags a click after withdrawal as stale', async () => {
    const { routes, tracker, session } = makeRoutes()
    tracker.withdraw(session)
    const response = await routes.postClick(postRequest('/api/jev-suggest/click', {
      sessionId: 'session-1', generation: 1, id: 'continue',
    }))
    const body = await response.json() as { ok: boolean; stale?: boolean }
    expect(body.stale).toBe(true)
  })

  it('rejects a broken or incomplete body with 400', async () => {
    const { routes, log } = makeRoutes()
    const broken = await routes.postClick(postRequest('/api/jev-suggest/click', '{broken'))
    expect(broken.status).toBe(400)
    const missing = await routes.postClick(postRequest('/api/jev-suggest/click', { sessionId: 'session-1' }))
    expect(missing.status).toBe(400)
    expect(log.events).toHaveLength(0)
  })
})
