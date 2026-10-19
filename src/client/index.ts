/**
 * Browser-half entry: registers the suggestion bar above the composer card.
 *
 * The `conversation.input.dock` slot is a list slot scoped to the session,
 * so the bar renders only inside a live conversation — the blank hero page
 * has nothing to suggest and renders nothing.
 *
 * @module jev-suggest/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.slots merge (the renderer owns the slot registry).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Conversation slot contracts (the 'conversation.input.dock' entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { JevSuggestBar } from './JevSuggestBar.tsx'

/** Required services. */
export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.effect(() =>
    ctx.slots.inject('conversation.input.dock', () =>
      ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'jev-suggest',
        order: 10,
      }, JevSuggestBar)), 'jev-suggest: suggestion bar')
}
