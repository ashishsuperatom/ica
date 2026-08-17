// The Teams bot: a message in → ask the engine → answer out. Each Teams
// conversation is one engine session (conversation id → sessionId), so follow-ups
// and edit:/modify land on the same thread of intent, exactly like a web session.

import { TeamsActivityHandler, MessageFactory, type TurnContext } from 'botbuilder'
import { askEngine } from './engine-client.js'
import { toAdaptiveCard, toText, hasStructure } from './answer-card.js'

export class SuperatomBot extends TeamsActivityHandler {
  constructor() {
    super()

    this.onMessage(async (context, next) => {
      const question = (context.activity.text ?? '').trim()
      if (!question) { await context.sendActivity("Ask me a question about your data."); await next(); return }

      // One engine session per Teams conversation → follow-ups + edit:/modify work.
      const sessionId = `teams:${context.activity.conversation?.id ?? 'unknown'}`

      await context.sendActivities([{ type: 'typing' }])
      try {
        const { answer } = await askEngine({
          question,
          sessionId,
          onWaking: () => { void context.sendActivity('Waking the engine…') },
          // NOTE (scaffold): a long analyst build can exceed a comfortable bot turn.
          // Typing indicators keep it alive here; the real fix is proactive messaging
          // — capture TurnContext.getConversationReference(context.activity) now and
          // send the answer when it lands, instead of awaiting inline.
        })

        if (hasStructure(answer)) await context.sendActivity({ attachments: [toAdaptiveCard(answer)] })
        else await context.sendActivity(MessageFactory.text(toText(answer)))
      } catch (err: any) {
        await context.sendActivity(`Sorry — I couldn't get an answer. (${err?.message ?? err})`)
      }
      await next()
    })

    // Greet when the bot is added to a chat/team.
    this.onMembersAdded(async (context, next) => {
      for (const m of context.activity.membersAdded ?? []) {
        if (m.id !== context.activity.recipient?.id) {
          await context.sendActivity("Hi — I'm Superatom. Ask me a question about your data and I'll compute an answer.")
        }
      }
      await next()
    })
  }
}

// Shared error handler for the adapter (wired in index.ts).
export async function onTurnError(context: TurnContext, error: Error): Promise<void> {
  console.error('[teams] unhandled error:', error)
  await context.sendActivity('The bot hit an unexpected error.')
}
