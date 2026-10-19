import { describe, expect, it } from 'vitest'
import { sessionIdOf } from '../src/client/JevSuggestBar.tsx'

/**
 * Pins the `SessionSnapshot` field name the bar reads. The first build read
 * `id` — the wire shape is `sessionId` — and the bar silently rendered
 * nothing: the loose cast in `sessionIdOf` is exactly where the type system
 * could not catch it, so this test is the guard.
 */
describe('JevSuggestBar — session id extraction', () => {
  it('reads SessionSnapshot.sessionId', () => {
    expect(sessionIdOf({ sessionId: 's1', running: false })).toBe('s1')
  })

  it('yields undefined for absent, empty, or wrong-typed ids', () => {
    expect(sessionIdOf(undefined)).toBeUndefined()
    expect(sessionIdOf({})).toBeUndefined()
    expect(sessionIdOf({ sessionId: '' })).toBeUndefined()
    expect(sessionIdOf({ sessionId: 42 })).toBeUndefined()
    expect(sessionIdOf({ id: 'legacy-shape' })).toBeUndefined()
  })
})
