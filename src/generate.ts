/**
 * Step 1 of the pipeline: generate next-action candidates with one ordinary
 * LLM call through `ctx.llm` (the same service the conversation itself uses).
 *
 * The system prompt pins the output contract — a bare JSON array of
 * `{ id, label }` — and the parser deliberately tolerates markdown fences
 * around it, because models wrap JSON in them often enough that failing
 * closed on a fence would burn a turn of latency for nothing. Everything
 * else (unknown shapes, empty arrays, error finishes) denies the turn's
 * suggestions rather than showing junk.
 *
 * @module jev-suggest/generate
 */

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

/** One generated candidate, before scoring. */
export interface Candidate {
  readonly id: string
  readonly label: string
}

/** The minimal `ctx.llm` surface this module needs; `Context['llm']` satisfies it. */
export interface LlmStreamPort {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** Normalized generation outcome; `error.reason` rides into the observer log. */
export type GenerateOutcome =
  | { kind: 'ok'; candidates: readonly Candidate[] }
  | { kind: 'error'; reason: string }

/** Everything one generation call needs. */
export interface GenerateArgs {
  readonly provider: string
  readonly model: string
  readonly goal: string
  readonly reply: string
  readonly maxSuggestions: number
  readonly signal?: AbortSignal
}

const SYSTEM_PROMPT = [
  'You analyze an AI coding-assistant conversation and propose what the human user could sensibly do next.',
  'Reply with ONLY a JSON array of objects, each with an "id" (short kebab-case identifier) and a "label" (one short imperative sentence the user could send as their next chat message).',
  'Cover distinct, plausible directions — continuing the current task, verifying what was done, correcting course, or moving on.',
  'No markdown, no commentary, JSON array only.',
].join(' ')

/** Generate candidates for one turn; never throws. */
export async function generateCandidates(port: LlmStreamPort, args: GenerateArgs): Promise<GenerateOutcome> {
  const request: GenerateOptions = {
    provider: args.provider,
    model: args.model,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: userPromptOf(args) }],
    }],
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  }
  let text = ''
  try {
    for await (const chunk of port.stream(request)) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
        return { kind: 'error', reason: `finish_${chunk.reason.kind}` }
      }
    }
  } catch {
    if (args.signal?.aborted) return { kind: 'error', reason: 'aborted' }
    return { kind: 'error', reason: 'generation_failed' }
  }
  return parseCandidates(text, args.maxSuggestions)
}

/** Compose the user turn: the request plus the reply it got. */
function userPromptOf(args: GenerateArgs): string {
  return [
    `User request:\n${args.goal}`,
    '',
    `Assistant's latest reply:\n${args.reply}`,
    '',
    `Propose up to ${args.maxSuggestions} next actions for the user.`,
  ].join('\n')
}

/** Parse the model output; fences tolerated, everything else strict. */
export function parseCandidates(text: string, maxSuggestions: number): GenerateOutcome {
  const stripped = stripFences(text)
  const start = stripped.indexOf('[')
  const end = stripped.lastIndexOf(']')
  if (start < 0 || end <= start) return { kind: 'error', reason: 'no_json_array' }
  let raw: unknown
  try {
    raw = JSON.parse(stripped.slice(start, end + 1))
  } catch {
    return { kind: 'error', reason: 'malformed_json' }
  }
  if (!Array.isArray(raw)) return { kind: 'error', reason: 'not_an_array' }
  const candidates: Candidate[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const { id, label } = entry as { id?: unknown; label?: unknown }
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue
    if (typeof label !== 'string' || label === '') continue
    seen.add(id)
    candidates.push({ id, label })
    if (candidates.length >= maxSuggestions) break
  }
  if (candidates.length === 0) return { kind: 'error', reason: 'no_valid_candidates' }
  return { kind: 'ok', candidates }
}

/** Drop a markdown code fence wrapping the payload, when present. */
function stripFences(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return trimmed
  const firstNewline = trimmed.indexOf('\n')
  if (firstNewline < 0) return trimmed
  const body = trimmed.slice(firstNewline + 1)
  const fence = body.lastIndexOf('```')
  return (fence >= 0 ? body.slice(0, fence) : body).trim()
}
