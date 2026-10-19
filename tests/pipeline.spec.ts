import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createSuggestionPipeline, type EffectiveConfig } from '../src/pipeline.ts'
import type { Candidate } from '../src/generate.ts'
import type { ScoreOutcome } from '../src/systemone.ts'
import type { JsonlWriter } from '../src/jsonl.ts'
import { SuggestTracker } from '../src/state.ts'

/** In-memory observer log. */
function memoryLog(): JsonlWriter & { events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = []
  return { events, append: event => { events.push({ ...event }) } }
}

function makeLlm(text: string): { llm: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> }; requests: GenerateOptions[] } {
  const requests: GenerateOptions[] = []
  return {
    requests,
    llm: {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options)
        for (let i = 0; i < text.length; i += 8) yield { type: 'text-delta', index: 0, text: text.slice(i, i + 8) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
}

const candidatesJson = JSON.stringify([
  { id: 'continue', label: 'continue the refactor' },
  { id: 'verify', label: 'run the tests' },
  { id: 'move-on', label: 'start a new task' },
])

interface Harness {
  tracker: SuggestTracker
  log: ReturnType<typeof memoryLog>
  session: object
  nowValue: { value: number }
  pipeline: ReturnType<typeof createSuggestionPipeline>
  scorerCalls: Array<{ state: string; candidates: readonly Candidate[] }>
  llmRequests: GenerateOptions[]
  setScorer: (outcome: ScoreOutcome) => void
  setFoldedRoute: (route: { provider: string; model: string } | undefined) => void
}

function makeHarness(config: Partial<EffectiveConfig> = {}, generatedText = candidatesJson): Harness {
  const tracker = new SuggestTracker()
  const session = {}
  tracker.recordSessionId(session, 'session-1')
  const log = memoryLog()
  const nowValue = { value: 10_000 }
  const { llm, requests } = makeLlm(generatedText)
  let scorerOutcome: ScoreOutcome = { kind: 'ok', scores: new Map([['continue', 0.6], ['verify', 0.3], ['move-on', 0.05]]) }
  const scorerCalls: Array<{ state: string; candidates: readonly Candidate[] }> = []
  const foldedRoute = { value: undefined as { provider: string; model: string } | undefined }
  const pipeline = createSuggestionPipeline({
    tracker,
    llm,
    scorer: async (state, candidates) => {
      scorerCalls.push({ state, candidates })
      return scorerOutcome
    },
    resolveRoute: () => foldedRoute.value,
    log,
    logger: { warn: () => {}, error: () => {} },
    resolveConfig: () => ({
      mode: 'on',
      provider: '', model: '',
      maxSuggestions: 5,
      minDisplayProbability: 0.05,
      generationTimeoutMs: 0,
      stateTtlMs: 5000,
      failureThreshold: 3,
      failureCooldownMs: 60_000,
      ...config,
    }),
    now: () => nowValue.value,
  })
  return {
    tracker, log, session, nowValue, pipeline, scorerCalls,
    llmRequests: requests,
    setScorer: outcome => { scorerOutcome = outcome },
    setFoldedRoute: (route: { provider: string; model: string } | undefined) => { foldedRoute.value = route },
  }
}

/** Fill the session with the context a completed turn leaves behind. */
function primeConversation(harness: Harness): void {
  harness.tracker.recordGoal(harness.session, 'refactor the config loader')
  harness.tracker.recordReply(harness.session, 1, 'the loader is refactored')
  harness.tracker.recordRoute(harness.session, 'prov', 'deepseek-v3')
}

/** One macrotask: drains every microtask the compute chain queued. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('pipeline — guards', () => {
  it('does nothing when the mode is off', async () => {
    const h = makeHarness({ mode: 'off' })
    primeConversation(h)
    h.pipeline.onTurnEnd(h.session, { kind: 'completed' })
    await settle()
    expect(h.llmRequests).toHaveLength(0)
    expect(h.log.events).toHaveLength(0)
  })

  it('ignores turns that did not complete cleanly', async () => {
    const h = makeHarness()
    primeConversation(h)
    for (const kind of ['aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked']) {
      h.pipeline.onTurnEnd(h.session, { kind })
    }
    await settle()
    expect(h.llmRequests).toHaveLength(0)
  })

  it('skips without context', async () => {
    const h = makeHarness()
    h.pipeline.onTurnEnd(h.session, { kind: 'completed' })
    await settle()
    expect(h.log.events).toEqual([{ t: 'suggest_skipped', sid: expect.any(String), reason: 'no_context' }])
    expect(h.llmRequests).toHaveLength(0)
  })

  it('errors with no_provider when neither config nor session names a route', async () => {
    const h = makeHarness()
    h.tracker.recordGoal(h.session, 'g')
    h.tracker.recordReply(h.session, 1, 'r')
    h.pipeline.onTurnEnd(h.session, { kind: 'completed' })
    await settle()
    expect(h.log.events).toEqual([{ t: 'suggest_error', sid: expect.any(String), reason: 'no_provider' }])
  })

  it('uses the session-log fold when live events starve (resumed session)', async () => {
    const h = makeHarness()
    // A resumed session: context recorded, but no live request/context event
    // ever fired (routes only log on change), so the tracker has no route.
    h.tracker.recordGoal(h.session, 'g')
    h.tracker.recordReply(h.session, 1, 'r')
    h.setFoldedRoute({ provider: 'prov', model: 'deepseek-v3' })
    h.pipeline.onTurnEnd(h.session, { kind: 'completed' })
    await settle()
    expect(h.llmRequests[0]!.provider).toBe('prov')
    expect(h.llmRequests[0]!.model).toBe('deepseek-v3')
    expect(h.tracker.getPublished('session-1')).not.toBeNull()
  })

  it('prefers the live-tracked route over the fold', async () => {
    const h = makeHarness()
    h.tracker.recordGoal(h.session, 'g')
    h.tracker.recordReply(h.session, 1, 'r')
    h.tracker.recordRoute(h.session, 'live-provider', 'live-model')
    h.setFoldedRoute({ provider: 'folded-provider', model: 'folded-model' })
    h.pipeline.onTurnEnd(h.session, { kind: 'completed' })
    await settle()
    expect(h.llmRequests[0]!.provider).toBe('live-provider')
    expect(h.llmRequests[0]!.model).toBe('live-model')
  })

  it('uses the config route over the session route', async () => {
    const h = makeHarness({ provider: 'fixed-provider', model: 'fixed-model' })
    primeConversation(h)
    h.pipeline.onTurnEnd(h.session, { kind: 'completed' })
    await settle()
    expect(h.llmRequests[0]!.provider).toBe('fixed-provider')
    expect(h.llmRequests[0]!.model).toBe('fixed-model')
  })

  it('skips duplicate state within the TTL and recomputes after it', async () => {
    const h = makeHarness()
    primeConversation(h)
    h.pipeline.onTurnEnd(h.session, { kind: 'completed' })
    await settle()
    expect(h.llmRequests).toHaveLength(1)
    h.pipeline.onTurnEnd(h.session, { kind: 'completed' })
    await settle()
    expect(h.llmRequests).toHaveLength(1)
    expect(h.log.events.at(-1)).toEqual({ t: 'suggest_skipped', sid: expect.any(String), reason: 'ttl_dedup' })
    h.nowValue.value += 6000
    h.pipeline.onTurnEnd(h.session, { kind: 'completed' })
    await settle()
    expect(h.llmRequests).toHaveLength(2)
  })

  it('recomputes immediately when the state key changes', async () => {
    const h = makeHarness()
    primeConversation(h)
    h.pipeline.onTurnEnd(h.session, { kind: 'completed' })
    await settle()
    h.tracker.recordGoal(h.session, 'a different task')
    h.pipeline.onTurnEnd(h.session, { kind: 'completed' })
    await settle()
    expect(h.llmRequests).toHaveLength(2)
  })
})

describe('pipeline — success paths', () => {
  it('publishes filtered, sorted, capped items with probabilities', async () => {
    const h = makeHarness({ maxSuggestions: 2 })
    primeConversation(h)
    h.pipeline.onTurnEnd(h.session, { kind: 'completed' })
    await settle()
    const published = h.tracker.getPublished('session-1')!
    expect(published.turn).toBe(1)
    expect(published.items.map(item => item.id)).toEqual(['continue', 'verify'])
    expect(published.items[0]!.probability).toBe(0.6)
    expect(h.log.events.at(-1)).toMatchObject({ t: 'suggest_computed', mode: 'on', count: 2 })
  })

  it('filters items below the display threshold', async () => {
    const h = makeHarness({ minDisplayProbability: 0.1 })
    primeConversation(h)
    h.pipeline.onTurnEnd(h.session, { kind: 'completed' })
    await settle()
    const published = h.tracker.getPublished('session-1')!
    expect(published.items.map(item => item.id)).toEqual(['continue', 'verify'])
  })

  it('computes but does not publish in shadow mode', async () => {
    const h = makeHarness({ mode: 'shadow' })
    primeConversation(h)
    h.pipeline.onTurnEnd(h.session, { kind: 'completed' })
    await settle()
    expect(h.llmRequests).toHaveLength(1)
    expect(h.tracker.getPublished('session-1')).toBeNull()
    expect(h.log.events.at(-1)).toMatchObject({ t: 'suggest_computed', mode: 'shadow' })
  })

  it('sends goal and reply to the scorer as the state', async () => {
    const h = makeHarness()
    primeConversation(h)
    h.pipeline.onTurnEnd(h.session, { kind: 'completed' })
    await settle()
    expect(h.scorerCalls[0]!.state).toContain('refactor the config loader')
    expect(h.scorerCalls[0]!.state).toContain('the loader is refactored')
    expect(h.scorerCalls[0]!.candidates.map(candidate => candidate.id)).toEqual(['continue', 'verify', 'move-on'])
  })

  it('skips below_display_threshold when nothing survives the filter', async () => {
    const h = makeHarness({ minDisplayProbability: 0.99 })
    primeConversation(h)
    h.pipeline.onTurnEnd(h.session, { kind: 'completed' })
    await settle()
    expect(h.tracker.getPublished('session-1')).toBeNull()
    expect(h.log.events.at(-1)).toEqual({ t: 'suggest_skipped', sid: expect.any(String), reason: 'below_display_threshold' })
  })
})

describe('pipeline — failures and cooldown', () => {
  it('counts generation failures and engages the cooldown after the threshold', async () => {
    const h = makeHarness({}, 'not json at all')
    primeConversation(h)
    for (let i = 0; i < 3; i++) {
      h.tracker.recordGoal(h.session, `goal ${i}`)
      h.pipeline.onTurnEnd(h.session, { kind: 'completed' })
      // eslint-disable-next-line no-await-in-loop -- sequential turn settling is the behavior under test
      await settle()
    }
    expect(h.log.events.filter(event => event['t'] === 'suggest_error')).toHaveLength(3)
    h.tracker.recordGoal(h.session, 'goal after cooldown')
    h.pipeline.onTurnEnd(h.session, { kind: 'completed' })
    await settle()
    expect(h.log.events.at(-1)).toEqual({ t: 'suggest_skipped', sid: expect.any(String), reason: 'cooldown' })
    expect(h.llmRequests).toHaveLength(3)
  })

  it('counts score failures the same way', async () => {
    const h = makeHarness()
    h.setScorer({ kind: 'error', reasons: ['rate_limited'] })
    primeConversation(h)
    for (let i = 0; i < 3; i++) {
      h.tracker.recordGoal(h.session, `goal ${i}`)
      h.pipeline.onTurnEnd(h.session, { kind: 'completed' })
      // eslint-disable-next-line no-await-in-loop -- sequential turn settling is the behavior under test
      await settle()
    }
    const errors = h.log.events.filter(event => event['t'] === 'suggest_error')
    expect(errors).toHaveLength(3)
    expect(errors.every(event => event['stage'] === 'score')).toBe(true)
  })

  it('resets the failure count after a success', async () => {
    const h = makeHarness()
    primeConversation(h)
    h.setScorer({ kind: 'error', reasons: ['rate_limited'] })
    h.pipeline.onTurnEnd(h.session, { kind: 'completed' })
    await settle()
    h.setScorer({ kind: 'ok', scores: new Map([['continue', 0.9]]) })
    h.tracker.recordGoal(h.session, 'goal 2')
    h.pipeline.onTurnEnd(h.session, { kind: 'completed' })
    await settle()
    expect(h.tracker.getPublished('session-1')).not.toBeNull()
    h.setScorer({ kind: 'error', reasons: ['rate_limited'] })
    h.tracker.recordGoal(h.session, 'goal 3')
    h.pipeline.onTurnEnd(h.session, { kind: 'completed' })
    await settle()
    expect(h.tracker.getPublished('session-1')).not.toBeNull()
  })
})

describe('pipeline — turn boundaries', () => {
  it('withdraws the published set when the next turn opens', async () => {
    const h = makeHarness()
    primeConversation(h)
    h.pipeline.onTurnEnd(h.session, { kind: 'completed' })
    await settle()
    expect(h.tracker.getPublished('session-1')).not.toBeNull()
    h.pipeline.onTurnStart(h.session)
    expect(h.tracker.getPublished('session-1')).toBeNull()
  })

  it('drops the published set when the session is disposed', async () => {
    const h = makeHarness()
    primeConversation(h)
    h.pipeline.onTurnEnd(h.session, { kind: 'completed' })
    await settle()
    h.pipeline.onSessionDisposed(h.session)
    expect(h.tracker.getPublished('session-1')).toBeNull()
  })
})
