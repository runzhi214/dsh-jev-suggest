/**
 * The suggestion panel: a titled card above the composer, one table row per
 * suggested next action — the option text left, then a flexible probability
 * bar filling the row's middle, then the percentage number right-aligned in
 * a fixed-width column. The bar absorbs the space a two-column layout would
 * leave empty, so every row reads as one continuous statistic. Clicking a
 * row copies its label into the draft through the session's input actions
 * and reports the click for telemetry.
 *
 * The panel renders only while a published set exists — the Host withdraws it
 * when the next turn opens, so an empty set (or a poll failure keeping the
 * last set) simply continues or stops rendering; there is no loading state
 * to show. All styling is inline over the DSW design tokens; no CSS Modules
 * needed for a single card.
 *
 * @module jev-suggest/client/JevSuggestBar
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
// Type-only: pulls the Conversation slot contracts this component's props
// are typed against.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SuggestionSet } from '../types.ts'
import { DEFAULT_POLL_INTERVAL_MS, reportClick, startSuggestionPolling } from './suggest-api.ts'

/** Full component props: dock owner share plus the session standard props. */
export type JevSuggestBarProps = PropsRuntime<'conversation.input.dock'>

/** The session id the dock's owner props carry; `undefined` without one.
 *
 * The field is `SessionSnapshot.sessionId` (dsh-api-session-controller's
 * wire shape) — NOT `id`. Exported for the unit test that pins the field
 * name, after a silent `undefined` read shipped the bar dark once.
 */
export function sessionIdOf(session: unknown): string | undefined {
  const id = (session as { sessionId?: unknown } | undefined)?.sessionId
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** The flexible probability track filling a row's middle column. */
function ProbabilityTrack({ probability }: { probability: number }): ReactNode {
  const fill = Math.round(Math.min(1, Math.max(0, probability)) * 100)
  return (
    <span
      aria-hidden
      style={{
        display: 'block',
        width: '100%',
        height: 4,
        borderRadius: 999,
        background: 'var(--dsw-alias-fill-tertiary, rgba(127,127,127,.25))',
        overflow: 'hidden',
      }}
    >
      <span
        style={{
          display: 'block',
          width: `${fill}%`,
          height: '100%',
          borderRadius: 999,
          background: 'var(--dsw-alias-state-success-primary, #34c759)',
        }}
      />
    </span>
  )
}

/** The percentage cell: fixed width so the numbers align into a column. */
function ProbabilityValue({ probability }: { probability: number }): ReactNode {
  return (
    <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-secondary)', textAlign: 'right' }}>
      {Math.round(probability * 100)}%
    </span>
  )
}

/** Render the suggestion panel, or nothing while no set is published. */
export function JevSuggestBar(props: JevSuggestBarProps): ReactNode {
  const sessionId = sessionIdOf(props.session)
  const [suggestions, setSuggestions] = useState<SuggestionSet | null>(null)

  useEffect(() => {
    setSuggestions(null)
    return startSuggestionPolling({
      sessionId,
      intervalMs: DEFAULT_POLL_INTERVAL_MS,
      onUpdate: setSuggestions,
    })
  }, [sessionId])

  if (sessionId === undefined || suggestions === null || suggestions.items.length === 0) return null

  // Container geometry ported from the official TodoPanel (ui-conversation
  // registers it into this very slot): centered on the conversation column —
  // `margin: 0 auto` plus the composer-card max-width — and inset by the
  // shared side-clearance/dock-inset variables instead of touching the edges.
  // Surface tokens (`--dsw-specific-menu` + elevation shadow) match that
  // panel's card look, so this reads as a native dock card.
  const panelStyle = {
    boxSizing: 'border-box',
    flex: 'none',
    overflow: 'hidden',
    margin: '0 auto 4px',
    width: 'calc(100% - 2 * var(--dsh-composer-side-clearance, 16px) - 4 * var(--dsh-composer-dock-inset, 8px))',
    maxWidth: 'calc(var(--dsh-composer-card-max-width, 952px) - 4 * var(--dsh-composer-dock-inset, 8px))',
    borderRadius: 'var(--dsw-radius-lg, 10px)',
    background: 'var(--dsw-specific-menu)',
    boxShadow: 'var(--dsw-elevation-panel)',
    backdropFilter: 'var(--dsw-menu-backdrop-filter)',
    '--dsw-elevation-stroke-color': 'var(--dsw-alias-border-l1)',
  } as CSSProperties

  return (
    <div
      role="group"
      aria-label="下一步建议"
      style={panelStyle}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 8,
          padding: '6px 12px',
          borderBottom: '1px solid var(--dsw-alias-separator-tertiary)',
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 'var(--dsh-content-font-size-secondary, 13px)', color: 'var(--dsw-alias-label-secondary)' }}>
          下一步建议
        </span>
        <span style={{ fontSize: 'var(--dsh-content-font-size-secondary, 13px)', fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-tertiary)' }}>
          第 {suggestions.turn} 轮
        </span>
      </div>
      <div role="table" aria-label="建议选项与概率">
        {suggestions.items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="row"
            aria-label={`填入建议：${item.label}（概率 ${Math.round(item.probability * 100)}%）`}
            onClick={() => {
              props.inputActions.setDraft(item.label)
              reportClick(sessionId, suggestions.generation, item.id)
            }}
            style={{
              display: 'grid',
              // text | flexible bar | number: the bar owns the row's middle,
              // so no dead whitespace sits between the columns.
              gridTemplateColumns: 'minmax(0, max-content) 1fr max-content',
              alignItems: 'center',
              gap: 10,
              width: '100%',
              padding: '5px 12px',
              font: 'inherit',
              fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
              lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
              textAlign: 'left',
              color: 'var(--dsw-alias-label-primary)',
              background: 'transparent',
              border: 'none',
              borderTop: index === 0 ? 'none' : '1px solid var(--dsw-alias-separator-tertiary)',
              cursor: 'pointer',
            }}
            onMouseEnter={event => { event.currentTarget.style.background = 'var(--dsw-alias-fill-tertiary)' }}
            onMouseLeave={event => { event.currentTarget.style.background = 'transparent' }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
            <ProbabilityTrack probability={item.probability} />
            <ProbabilityValue probability={item.probability} />
          </button>
        ))}
      </div>
    </div>
  )
}
