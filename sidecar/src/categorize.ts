import type { LlmManager } from './llm.js';
import type { Repo } from './repo.js';

/** Fixed spending taxonomy. The LLM is constrained to exactly these. */
export const CATEGORIES = [
  'Groceries',
  'Dining',
  'Transport',
  'Fuel',
  'Shopping',
  'Utilities',
  'Housing',
  'Insurance',
  'Health',
  'Entertainment',
  'Subscriptions',
  'Travel',
  'Education',
  'Income',
  'Transfers',
  'Fees',
  'Other',
] as const;

export type Category = (typeof CATEGORIES)[number];

function normalizeKey(description: string): string {
  return description.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface CategorizeStatus {
  state: 'idle' | 'running' | 'done' | 'error';
  total: number;
  done: number;
  message: string;
}

const SYSTEM_PROMPT =
  'You categorize bank and credit-card transactions for a personal finance app. ' +
  'Transaction descriptions are often in Hebrew. For each transaction, choose the ' +
  'single best-fitting spending category from the allowed list. Use "Other" only ' +
  'when nothing else fits.';

/**
 * Categorizes uncategorized transactions through four tiers, in precedence
 * order — each only touches what the previous one left `category IS NULL`:
 *   1. the user's merchant rules (exact description),
 *   2. the description cache,
 *   3. the built-in substring rules — one set-based SQL pass in the DB
 *      (`repo.applyBuiltinRules`) rather than a per-transaction JS loop,
 *   4. the on-device LLM, for whatever is left.
 * Runs as a background job.
 */
export class Categorizer {
  private status: CategorizeStatus = {
    state: 'idle',
    total: 0,
    done: 0,
    message: 'Not run yet.',
  };

  constructor(
    private readonly repo: Repo,
    private readonly llm: LlmManager,
  ) {}

  getStatus(): CategorizeStatus {
    return this.status;
  }

  start(): void {
    if (this.status.state === 'running') return;
    this.status = { state: 'running', total: 0, done: 0, message: 'Starting…' };
    void this.run();
  }

  private async run(): Promise<void> {
    try {
      const pending = this.repo.uncategorizedDescriptions();
      this.status.total = pending.length;
      if (pending.length === 0) {
        this.status = { state: 'done', total: 0, done: 0, message: 'Everything is categorized.' };
        return;
      }

      // The live category set comes from the DB so user-added categories count
      // for both the whitelist and the LLM enum. Falls back to the hardcoded
      // seed list if the table somehow comes back empty.
      const liveNames = this.repo.listCategories().map((c) => c.name);
      const allowedNames = liveNames.length > 0 ? liveNames : [...CATEGORIES];
      const allowedSet = new Set<string>(allowedNames);

      // User-set merchant rules take priority over everything else.
      const userRules = new Map(
        this.repo.listMerchantRules().map((r) => [r.description, r.category]),
      );
      let byUser = 0;
      let byCache = 0;
      let byRule = 0;
      let byLlm = 0;

      // Tiers 1 + 2: the user's merchant rules, then the description cache —
      // both exact-description lookups, walked per distinct description.
      for (const description of pending) {
        const key = normalizeKey(description);
        let category: string | null = null;
        let source = '';

        const userRule = userRules.get(description);
        if (userRule && allowedSet.has(userRule)) {
          category = userRule;
          source = 'user';
          byUser += 1;
        }
        if (!category) {
          const cached = this.repo.getCachedCategory(key);
          if (cached && allowedSet.has(cached.category)) {
            category = cached.category;
            source = cached.source;
            byCache += 1;
          }
        }
        if (category) {
          this.repo.applyCategory(description, category);
          this.repo.cacheCategory(key, category, source);
          this.status.done += 1;
        }
      }

      // Tier 3: the built-in substring rules, applied to every still-
      // uncategorized transaction in one set-based SQL pass (INSTR + priority,
      // run inside SQLite) rather than a JS loop over each description.
      byRule = this.repo.applyBuiltinRules();
      this.status.done = Math.min(this.status.total, this.status.done + byRule);
      this.status.message = `Categorized ${this.status.done} of ${this.status.total}…`;

      // Tier 4: the on-device LLM, for whatever the deterministic tiers left
      // behind. Only spin up a model when there is leftover work.
      const remaining = this.repo.uncategorizedDescriptions();
      const classifier =
        remaining.length > 0 ? await this.createLlmClassifier(allowedNames, allowedSet) : null;
      if (classifier) {
        try {
          for (const description of remaining) {
            const key = normalizeKey(description);
            const category = await classifier.classify(description);
            this.repo.applyCategory(description, category);
            this.repo.cacheCategory(key, category, 'llm');
            byLlm += 1;
            this.status.done = Math.min(this.status.total, this.status.done + 1);
            this.status.message = `Categorized ${this.status.done} of ${this.status.total}…`;
          }
        } finally {
          classifier.dispose();
        }
      }

      // A trailing note only when work is genuinely stranded for lack of a model.
      const note =
        this.repo.uncategorizedDescriptions().length > 0
          ? ' Download the AI model to categorize the rest.'
          : '';
      // Report your own merchant rules distinctly from the built-in substring
      // rules instead of lumping both under "by rules".
      const yourRules = byUser > 0 ? `${byUser} by your rules, ` : '';
      this.status = {
        state: 'done',
        total: this.status.total,
        done: this.status.done,
        message: `Done — ${yourRules}${byRule} by rules, ${byLlm} by AI, ${byCache} from cache.${note}`,
      };
    } catch (err) {
      this.status = {
        state: 'error',
        total: this.status.total,
        done: this.status.done,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Builds an LLM classifier if a provider is ready; otherwise null (rules only).
   *  Takes the live category names so the JSON-schema enum reflects the
   *  user's actual category set — including any they have added. */
  private async createLlmClassifier(
    allowedNames: string[],
    allowedSet: Set<string>,
  ): Promise<{
    classify: (description: string) => Promise<string>;
    dispose: () => void;
  } | null> {
    if (!this.llm.isReady()) return null;

    const session = await this.llm.openSession({
      system: SYSTEM_PROMPT,
      contextSize: 2048,
    });

    const schema = {
      type: 'object',
      properties: { category: { enum: allowedNames } },
    };

    const classify = async (description: string): Promise<string> => {
      try {
        const response = await session.prompt(`Transaction: "${description}"`, {
          jsonSchema: schema,
        });
        const parsed = JSON.parse(response) as { category?: string };
        return parsed.category && allowedSet.has(parsed.category)
          ? parsed.category
          : 'Other';
      } catch {
        return 'Other';
      }
    };

    return { classify, dispose: () => session.dispose() };
  }
}
