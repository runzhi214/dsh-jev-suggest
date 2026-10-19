/**
 * Best-effort JSONL observer log.
 *
 * Privacy contract: callers may pass only
 * candidate ids, probabilities, counts, reasons, and timings — never label
 * text, task text, context fragments, credentials, or the API key. This
 * module serializes whatever it is given; enforcing that boundary is the
 * caller's job.
 *
 * Writes are synchronous, fire-and-forget, and never throw: the first write
 * failure disables the writer after one warning. The file is created with
 * mode 0600 and the parent directory on demand.
 *
 * @module jev-suggest/jsonl
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'

/** One JSONL observer log. */
export interface JsonlWriter {
  /** Append one event; silently dropped after the writer disables itself. */
  append(event: Record<string, unknown>): void
}

/** Options accepted by {@link createJsonlWriter}. */
export interface JsonlWriterOptions {
  /** Warn sink for the single disable-on-failure warning. Default: silence. */
  warn?: (message: string) => void
}

/** Observer logs are private to the local user. */
const FILE_MODE = 0o600

/**
 * Create the observer log writer.
 *
 * @param path - log file path; empty string disables logging entirely.
 * @param options - warn sink.
 * @returns the writer, or `null` when logging is disabled by configuration.
 */
export function createJsonlWriter(path: string, options: JsonlWriterOptions = {}): JsonlWriter | null {
  if (!path) return null
  const warn = options.warn ?? (() => {})
  let disabled = false
  return {
    append(event) {
      if (disabled) return
      try {
        mkdirSync(dirname(path), { recursive: true })
        if (!existsSync(path)) closeSync(openSync(path, 'w', FILE_MODE))
        appendFileSync(path, `${JSON.stringify({ time: Date.now(), ...event })}\n`)
      } catch (error) {
        disabled = true
        warn(`jev-suggest: JSONL log disabled after write failure: ${String(error)}`)
      }
    },
  }
}
