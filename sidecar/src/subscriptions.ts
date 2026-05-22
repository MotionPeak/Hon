import { createHash } from 'node:crypto';
import { LlamaChatSession } from 'node-llama-cpp';
import type { LlmManager } from './llm.js';

// A lapsed subscription is not always cancelled — banks often re-bill the same
// service under a changed descriptor (an abbreviation, an added transaction
// code, a Hebrew/English swap). This matcher asks the on-device model whether a
// lapsed subscription is really the same merchant as one still active, so the
// Subscriptions tab can drop it from "probably cancelled".

const NONE = '__none__';

const SYSTEM_PROMPT =
  'You help a personal-finance app decide whether a lapsed subscription is ' +
  'genuinely cancelled or simply the same service still being billed under a ' +
  'renamed descriptor. Bank statements show the same merchant under slightly ' +
  'different names — abbreviations, added codes, Hebrew/English variants. ' +
  'Given one lapsed subscription name, decide which of the active ' +
  'subscriptions — if any — is the SAME underlying service. Match only when ' +
  'you are confident it is the same merchant; otherwise answer "' + NONE + '".';

export interface MatchResult {
  // False when no on-device model is loaded yet — the caller can retry later.
  ready: boolean;
  // Maps a lapsed subscription name to the active one it is the same service as.
  aliases: Record<string, string>;
}

export class SubscriptionMatcher {
  // Keyed by a hash of the (active, dead) name sets — the LLM pass is skipped
  // entirely while the user's subscriptions are unchanged.
  private readonly cache = new Map<string, Record<string, string>>();

  constructor(private readonly llm: LlmManager) {}

  /**
   * Maps each lapsed subscription name to the active subscription it is the
   * same service as. Names with no confident match are omitted.
   */
  async match(active: string[], dead: string[]): Promise<MatchResult> {
    const activeNames = unique(active);
    const deadNames = unique(dead);
    if (activeNames.length === 0 || deadNames.length === 0) {
      return { ready: true, aliases: {} };
    }

    const key = createHash('sha1')
      .update(JSON.stringify([[...activeNames].sort(), [...deadNames].sort()]))
      .digest('hex');
    const cached = this.cache.get(key);
    if (cached) return { ready: true, aliases: cached };

    const llama = this.llm.getLlama();
    const model = this.llm.getModel();
    if (!llama || !model) return { ready: false, aliases: {} };

    const context = await model.createContext({ contextSize: 2048 });
    const aliases: Record<string, string> = {};
    try {
      const session = new LlamaChatSession({
        contextSequence: context.getSequence(),
        systemPrompt:
          SYSTEM_PROMPT +
          '\n\nActive subscriptions:\n' +
          activeNames.map((name) => `- ${name}`).join('\n'),
      });
      const grammar = await llama.createGrammarForJsonSchema({
        type: 'object',
        properties: { sameAs: { enum: [...activeNames, NONE] } },
      } as const);

      for (const name of deadNames) {
        try {
          const response = await session.prompt(
            `Lapsed subscription: "${name}". Which active subscription is the same service?`,
            { grammar },
          );
          const parsed = grammar.parse(response) as { sameAs?: string };
          session.resetChatHistory();
          if (parsed.sameAs && parsed.sameAs !== NONE && activeNames.includes(parsed.sameAs)) {
            aliases[name] = parsed.sameAs;
          }
        } catch {
          // Skip a name the model could not classify — treat it as unmatched.
        }
      }
    } finally {
      context.dispose();
    }

    this.cache.set(key, aliases);
    return { ready: true, aliases };
  }
}

function unique(names: string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}
