import { describe, expect, it } from 'vitest'
import { extractText, GOAL_MAX_CHARS, REPLY_MAX_CHARS, stateKeyOf, SuggestTracker } from '../src/state.ts'

describe('state — collectors', () => {
  it('records goal, reply, and route into per-session facts', () => {
    const tracker = new SuggestTracker()
    const session = {}
    tracker.recordGoal(session, 'fix the failing test')
    tracker.recordReply(session, 3, 'the test passes now')
    tracker.recordRoute(session, 'prov', 'deepseek-v3')
    expect(tracker.factsFor(session)).toEqual({
      sid: undefined, fullId: undefined,
      goal: 'fix the failing test',
      lastAssistant: 'the test passes now',
      provider: 'prov', model: 'deepseek-v3', turn: 3,
    })
  })

  it('truncates the goal and the reply to their caps', () => {
    const tracker = new SuggestTracker()
    const session = {}
    const long = 'x'.repeat(5000)
    tracker.recordGoal(session, long)
    tracker.recordReply(session, 1, long)
    expect(tracker.factsFor(session)!.goal).toHaveLength(GOAL_MAX_CHARS)
    expect(tracker.factsFor(session)!.lastAssistant).toHaveLength(REPLY_MAX_CHARS)
  })

  it('keeps sessions independent', () => {
    const tracker = new SuggestTracker()
    const a = {}, b = {}
    tracker.recordGoal(a, 'goal a')
    tracker.recordGoal(b, 'goal b')
    expect(tracker.factsFor(a)!.goal).toBe('goal a')
    expect(tracker.factsFor(b)!.goal).toBe('goal b')
    expect(tracker.factsFor({})).toBeUndefined()
  })
})

describe('state — session identity', () => {
  it('records the full id and the short hashed sid together', () => {
    const tracker = new SuggestTracker()
    const session = {}
    tracker.recordSessionId(session, 'session-uuid-1')
    const facts = tracker.factsFor(session)!
    expect(facts.fullId).toBe('session-uuid-1')
    expect(facts.sid).toMatch(/^[0-9a-f]{8}$/)
    expect(tracker.sidFor('session-uuid-1')).toBe(facts.sid)
  })

  it('ignores empty or absent ids', () => {
    const tracker = new SuggestTracker()
    const session = {}
    tracker.recordSessionId(session, undefined)
    tracker.recordSessionId(session, '')
    expect(tracker.factsFor(session)).toBeUndefined()
  })
})

describe('state — published sets', () => {
  it('publishes under the full id and bumps the generation per publish', () => {
    const tracker = new SuggestTracker()
    const session = {}
    tracker.recordSessionId(session, 's1')
    const first = tracker.publish(session, { turn: 1, items: [] })!
    const second = tracker.publish(session, { turn: 2, items: [] })!
    expect(first.generation).toBe(1)
    expect(second.generation).toBe(2)
    expect(tracker.getPublished('s1')).toEqual(second)
  })

  it('refuses to publish without a full id', () => {
    const tracker = new SuggestTracker()
    expect(tracker.publish({}, { turn: 1, items: [] })).toBeNull()
  })

  it('withdraws on demand and disposes by full id', () => {
    const tracker = new SuggestTracker()
    const session = {}
    tracker.recordSessionId(session, 's1')
    tracker.publish(session, { turn: 1, items: [] })
    tracker.withdraw(session)
    expect(tracker.getPublished('s1')).toBeNull()
    tracker.publish(session, { turn: 2, items: [] })
    tracker.dispose('s1')
    expect(tracker.getPublished('s1')).toBeNull()
    expect(tracker.sidFor('s1')).toBeUndefined()
  })
})

describe('state — helpers', () => {
  it('stateKeyOf reflects goal and reply only', () => {
    const tracker = new SuggestTracker()
    const session = {}
    tracker.recordGoal(session, 'g')
    tracker.recordReply(session, 1, 'r')
    tracker.recordRoute(session, 'p', 'm')
    expect(stateKeyOf(tracker.factsFor(session)!)).toBe(JSON.stringify(['g', 'r']))
  })

  it('extractText joins text blocks and skips the rest', () => {
    expect(extractText([
      { type: 'text', text: 'a' },
      { type: 'reasoning', text: 'hidden' },
      { type: 'text', text: 'b' },
    ])).toBe('a\nb')
  })
})
