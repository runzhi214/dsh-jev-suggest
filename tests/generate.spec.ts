import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { generateCandidates, parseCandidates, type LlmStreamPort } from '../src/generate.ts'

/** A port whose stream yields the given text then a clean finish. */
function portOf(text: string, finish: { type: 'finish'; reason: { kind: 'stop' } | { kind: 'error' } | { kind: 'aborted' } }): LlmStreamPort & { requests: GenerateOptions[] } {
  const requests: GenerateOptions[] = []
  return {
    requests,
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(options)
      for (let i = 0; i < text.length; i += 8) yield { type: 'text-delta', index: 0, text: text.slice(i, i + 8) }
      yield finish
    },
  }
}

const stopFinish = { type: 'finish', reason: { kind: 'stop' } } as const
const args = { provider: 'prov', model: 'deepseek-v3', goal: 'fix the bug', reply: 'fixed', maxSuggestions: 5 }

describe('generate — happy paths', () => {
  it('parses a bare JSON array', async () => {
    const port = portOf('[{"id":"continue","label":"continue the refactor"}]', stopFinish)
    const outcome = await generateCandidates(port, args)
    expect(outcome).toEqual({
      kind: 'ok',
      candidates: [{ id: 'continue', label: 'continue the refactor' }],
    })
  })

  it('tolerates a markdown fence and prose around the array', async () => {
    const port = portOf('```json\n[{"id":"a","label":"run the tests"}]\n```', stopFinish)
    const outcome = await generateCandidates(port, args)
    expect(outcome.kind).toBe('ok')
  })

  it('drops invalid entries and duplicate ids, caps at maxSuggestions', async () => {
    const port = portOf(
      '[{"id":"a","label":"a"},{"id":"a","label":"dup"},{"label":"no id"},"junk",{"id":"b","label":"b"},{"id":"c","label":"c"}]',
      stopFinish,
    )
    const outcome = await generateCandidates(port, { ...args, maxSuggestions: 2 })
    expect(outcome).toEqual({
      kind: 'ok',
      candidates: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }],
    })
  })

  it('sends the route, the system prompt, and the conversation pair', async () => {
    const port = portOf('[{"id":"a","label":"a"}]', stopFinish)
    await generateCandidates(port, args)
    const [request] = port.requests
    expect(request!.provider).toBe('prov')
    expect(request!.model).toBe('deepseek-v3')
    expect(request!.system).toContain('JSON array')
    expect(request!.messages).toHaveLength(1)
    expect(request!.messages[0]!.role).toBe('user')
    expect(JSON.stringify(request!.messages)).toContain('fix the bug')
    expect(JSON.stringify(request!.messages)).toContain('fixed')
  })
})

describe('generate — denials', () => {
  it('reports no_json_array without brackets', async () => {
    const outcome = await generateCandidates(portOf('no json here', stopFinish), args)
    expect(outcome).toEqual({ kind: 'error', reason: 'no_json_array' })
  })

  it('reports malformed_json for broken JSON between the brackets', async () => {
    const outcome = await generateCandidates(portOf('[{"id":}]', stopFinish), args)
    expect(outcome).toEqual({ kind: 'error', reason: 'malformed_json' })
  })

  it('reports no_json_array for a JSON object without brackets', async () => {
    const outcome = await generateCandidates(portOf('{"id":"a"}', stopFinish), args)
    expect(outcome).toEqual({ kind: 'error', reason: 'no_json_array' })
  })

  it('reports no_valid_candidates when every entry is unusable', async () => {
    const outcome = await generateCandidates(portOf('[{"id":"","label":""}]', stopFinish), args)
    expect(outcome).toEqual({ kind: 'error', reason: 'no_valid_candidates' })
  })

  it('reports the finish kind when the stream ends in error or abort', async () => {
    const errored = await generateCandidates(portOf('partial', { type: 'finish', reason: { kind: 'error' } }), args)
    expect(errored).toEqual({ kind: 'error', reason: 'finish_error' })
    const aborted = await generateCandidates(portOf('partial', { type: 'finish', reason: { kind: 'aborted' } }), args)
    expect(aborted).toEqual({ kind: 'error', reason: 'finish_aborted' })
  })

  it('reports aborted when the caller cancels mid-stream', async () => {
    const controller = new AbortController()
    const port: LlmStreamPort = {
      async *stream(): AsyncIterable<StreamChunk> {
        yield { type: 'text-delta', index: 0, text: 'partial' }
        controller.abort()
        throw new Error('cancelled')
      },
    }
    const outcome = await generateCandidates(port, { ...args, signal: controller.signal })
    expect(outcome).toEqual({ kind: 'error', reason: 'aborted' })
  })

  it('reports generation_failed for an unexpected throw', async () => {
    const port: LlmStreamPort = {
      async *stream(): AsyncIterable<StreamChunk> {
        yield { type: 'text-delta', index: 0, text: 'x' }
        throw new Error('adapter down')
      },
    }
    const outcome = await generateCandidates(port, args)
    expect(outcome).toEqual({ kind: 'error', reason: 'generation_failed' })
  })
})

describe('generate — parseCandidates unit', () => {
  it('slices from the first [ to the last ]', () => {
    expect(parseCandidates('prefix [ {"id":"a","label":"a"} ] suffix', 5).kind).toBe('ok')
  })
})
