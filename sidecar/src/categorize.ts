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

const CATEGORY_SET = new Set<string>(CATEGORIES);

interface Rule {
  match: string;
  category: Category;
}

// Substring rules, checked in order — specific brands first, broad words last.
// `match` strings are lowercase; Hebrew is unaffected by case folding.
const RULES: Rule[] = [
  // Subscriptions (specific brands before the broad "amazon" Shopping rule)
  { match: 'netflix', category: 'Subscriptions' },
  { match: 'נטפליקס', category: 'Subscriptions' },
  { match: 'spotify', category: 'Subscriptions' },
  { match: 'ספוטיפיי', category: 'Subscriptions' },
  { match: 'youtube', category: 'Subscriptions' },
  { match: 'disney', category: 'Subscriptions' },
  { match: 'apple.com', category: 'Subscriptions' },
  { match: 'icloud', category: 'Subscriptions' },
  { match: 'openai', category: 'Subscriptions' },
  { match: 'chatgpt', category: 'Subscriptions' },
  { match: 'amazon prime', category: 'Subscriptions' },
  { match: 'מנוי', category: 'Subscriptions' },

  // Insurance
  { match: 'ביטוח', category: 'Insurance' },
  { match: 'insurance', category: 'Insurance' },
  { match: 'הראל', category: 'Insurance' },
  { match: 'כלל ביטוח', category: 'Insurance' },
  { match: 'מגדל', category: 'Insurance' },
  { match: 'פניקס', category: 'Insurance' },

  // Fuel
  { match: 'סונול', category: 'Fuel' },
  { match: 'דור אלון', category: 'Fuel' },
  { match: 'תחנת דלק', category: 'Fuel' },
  { match: 'דלקן', category: 'Fuel' },
  { match: 'פז יב', category: 'Fuel' },

  // Groceries
  { match: 'שופרסל', category: 'Groceries' },
  { match: 'רמי לוי', category: 'Groceries' },
  { match: 'ויקטורי', category: 'Groceries' },
  { match: 'יוחננוף', category: 'Groceries' },
  { match: 'אושר עד', category: 'Groceries' },
  { match: 'טיב טעם', category: 'Groceries' },
  { match: 'יינות ביתן', category: 'Groceries' },
  { match: 'מגה בעיר', category: 'Groceries' },
  { match: 'סופרמרקט', category: 'Groceries' },
  { match: 'carrefour', category: 'Groceries' },
  { match: 'קרפור', category: 'Groceries' },
  { match: 'am:pm', category: 'Groceries' },

  // Dining
  { match: 'מקדונלד', category: 'Dining' },
  { match: 'ארומה', category: 'Dining' },
  { match: 'קפה קפה', category: 'Dining' },
  { match: 'רולדין', category: 'Dining' },
  { match: 'פיצה האט', category: 'Dining' },
  { match: 'דומינוס', category: 'Dining' },
  { match: 'בורגר', category: 'Dining' },
  { match: 'מסעד', category: 'Dining' },
  { match: 'וולט', category: 'Dining' },
  { match: 'wolt', category: 'Dining' },
  { match: '10bis', category: 'Dining' },
  { match: 'תן ביס', category: 'Dining' },
  { match: 'לנדוור', category: 'Dining' },
  { match: 'kfc', category: 'Dining' },

  // Transport
  { match: 'רכבת ישראל', category: 'Transport' },
  { match: 'רב קו', category: 'Transport' },
  { match: 'רב-קו', category: 'Transport' },
  { match: 'gett', category: 'Transport' },
  { match: 'yango', category: 'Transport' },
  { match: 'moovit', category: 'Transport' },
  { match: 'אגד', category: 'Transport' },
  { match: 'מטרופולין', category: 'Transport' },
  { match: 'חניון', category: 'Transport' },
  { match: 'pango', category: 'Transport' },
  { match: 'פנגו', category: 'Transport' },
  { match: 'סלופארק', category: 'Transport' },
  { match: 'cellopark', category: 'Transport' },
  { match: 'כביש 6', category: 'Transport' },
  { match: 'נתיבי איילון', category: 'Transport' },

  // Utilities
  { match: 'חברת חשמל', category: 'Utilities' },
  { match: 'בזק', category: 'Utilities' },
  { match: 'הוט', category: 'Utilities' },
  { match: 'partner', category: 'Utilities' },
  { match: 'פרטנר', category: 'Utilities' },
  { match: 'סלקום', category: 'Utilities' },
  { match: 'cellcom', category: 'Utilities' },
  { match: 'פלאפון', category: 'Utilities' },
  { match: 'גולן טלקום', category: 'Utilities' },
  { match: 'מי אביבים', category: 'Utilities' },
  { match: 'מקורות', category: 'Utilities' },
  { match: 'תאגיד המים', category: 'Utilities' },

  // Housing
  { match: 'שכר דירה', category: 'Housing' },
  { match: 'ארנונה', category: 'Housing' },
  { match: 'ועד בית', category: 'Housing' },
  { match: 'משכנתא', category: 'Housing' },
  { match: 'עיריית', category: 'Housing' },
  { match: 'עירית', category: 'Housing' },

  // Health
  { match: 'סופר פארם', category: 'Health' },
  { match: 'super-pharm', category: 'Health' },
  { match: 'ניו פארם', category: 'Health' },
  { match: 'בית מרקחת', category: 'Health' },
  { match: 'מכבי', category: 'Health' },
  { match: 'כללית', category: 'Health' },
  { match: 'מאוחדת', category: 'Health' },
  { match: 'קופת חולים', category: 'Health' },

  // Entertainment
  { match: 'סינמה סיטי', category: 'Entertainment' },
  { match: 'יס פלאנט', category: 'Entertainment' },
  { match: 'רב חן', category: 'Entertainment' },
  { match: 'סינמטק', category: 'Entertainment' },
  { match: 'תיאטר', category: 'Entertainment' },
  { match: 'steam', category: 'Entertainment' },
  { match: 'playstation', category: 'Entertainment' },

  // Travel
  { match: 'בית מלון', category: 'Travel' },
  { match: 'airbnb', category: 'Travel' },
  { match: 'booking.com', category: 'Travel' },
  { match: 'אל על', category: 'Travel' },
  { match: 'אלעל', category: 'Travel' },
  { match: 'el al', category: 'Travel' },
  { match: 'ארקיע', category: 'Travel' },
  { match: 'wizz', category: 'Travel' },
  { match: 'נמל תעופה', category: 'Travel' },
  { match: 'expedia', category: 'Travel' },
  { match: 'פתאל', category: 'Travel' },

  // Education
  { match: 'אוניברסיט', category: 'Education' },
  { match: 'מכלל', category: 'Education' },
  { match: 'בית ספר', category: 'Education' },
  { match: 'צהרון', category: 'Education' },
  { match: 'udemy', category: 'Education' },
  { match: 'coursera', category: 'Education' },
  { match: 'שכר לימוד', category: 'Education' },

  // Shopping ("amazon" here — after "amazon prime" above)
  { match: 'ikea', category: 'Shopping' },
  { match: 'איקאה', category: 'Shopping' },
  { match: 'קסטרו', category: 'Shopping' },
  { match: 'רנואר', category: 'Shopping' },
  { match: 'מקס סטוק', category: 'Shopping' },
  { match: 'הום סנטר', category: 'Shopping' },
  { match: 'aliexpress', category: 'Shopping' },
  { match: 'עלי אקספרס', category: 'Shopping' },
  { match: 'amazon', category: 'Shopping' },
  { match: 'אמזון', category: 'Shopping' },
  { match: 'ebay', category: 'Shopping' },
  { match: 'shein', category: 'Shopping' },
  { match: 'טרמינל איקס', category: 'Shopping' },

  // Income
  { match: 'משכורת', category: 'Income' },
  { match: 'שכר עבודה', category: 'Income' },
  { match: 'זיכוי', category: 'Income' },
  { match: 'דיבידנד', category: 'Income' },

  // Transfers (broad — kept late)
  { match: 'paybox', category: 'Transfers' },
  { match: 'פייבוקס', category: 'Transfers' },
  { match: 'משיכת מזומן', category: 'Transfers' },
  { match: 'כספומט', category: 'Transfers' },
  { match: 'הפקדה', category: 'Transfers' },
  { match: 'העברה', category: 'Transfers' },
  { match: 'העברת', category: 'Transfers' },

  // Fees (broad — kept last)
  { match: 'דמי כרטיס', category: 'Fees' },
  { match: 'דמי ניהול', category: 'Fees' },
  { match: 'דמי טיפול', category: 'Fees' },
  { match: 'עמלת', category: 'Fees' },
  { match: 'עמלה', category: 'Fees' },
];

/** Categorizes a description with the rule map; null if no rule matches. */
export function categorizeByRule(description: string): Category | null {
  const haystack = description.toLowerCase();
  for (const rule of RULES) {
    if (haystack.includes(rule.match)) return rule.category;
  }
  return null;
}

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

const GRAMMAR_SCHEMA = {
  type: 'object',
  properties: { category: { enum: CATEGORIES } },
} as const;

/**
 * Categorizes uncategorized transactions: a cache lookup, then the rule map,
 * then the on-device LLM (if a model is loaded). Runs as a background job.
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
      const descriptions = this.repo.uncategorizedDescriptions();
      this.status.total = descriptions.length;
      if (descriptions.length === 0) {
        this.status = { state: 'done', total: 0, done: 0, message: 'Everything is categorized.' };
        return;
      }

      const classifier = await this.createLlmClassifier();
      // User-set merchant rules take priority over everything else.
      const userRules = new Map(
        this.repo.listMerchantRules().map((r) => [r.description, r.category]),
      );
      let byRule = 0;
      let byLlm = 0;
      let byCache = 0;

      try {
        for (const description of descriptions) {
          const key = normalizeKey(description);
          let category: Category | null = null;
          let source = 'rule';

          const userRule = userRules.get(description);
          if (userRule && CATEGORY_SET.has(userRule)) {
            category = userRule as Category;
            source = 'user';
            byRule += 1;
          }
          if (!category) {
            const cached = this.repo.getCachedCategory(key);
            if (cached && CATEGORY_SET.has(cached.category)) {
              category = cached.category as Category;
              source = cached.source;
              byCache += 1;
            }
          }
          if (!category) {
            const ruled = categorizeByRule(description);
            if (ruled) {
              category = ruled;
              source = 'rule';
              byRule += 1;
            }
          }
          if (!category && classifier) {
            category = await classifier.classify(description);
            source = 'llm';
            byLlm += 1;
          }
          if (category) {
            this.repo.applyCategory(description, category);
            this.repo.cacheCategory(key, category, source);
          }
          this.status.done += 1;
          this.status.message = `Categorized ${this.status.done} of ${this.status.total}…`;
        }
      } finally {
        classifier?.dispose();
      }

      const note = classifier ? '' : ' Download the AI model to categorize the rest.';
      this.status = {
        state: 'done',
        total: this.status.total,
        done: this.status.done,
        message: `Done — ${byRule} by rules, ${byLlm} by AI, ${byCache} from cache.${note}`,
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

  /** Builds an LLM classifier if a provider is ready; otherwise null (rules only). */
  private async createLlmClassifier(): Promise<{
    classify: (description: string) => Promise<Category>;
    dispose: () => void;
  } | null> {
    if (!this.llm.isReady()) return null;

    const session = await this.llm.openSession({
      system: SYSTEM_PROMPT,
      contextSize: 2048,
    });

    const classify = async (description: string): Promise<Category> => {
      try {
        const response = await session.prompt(`Transaction: "${description}"`, {
          jsonSchema: GRAMMAR_SCHEMA,
        });
        const parsed = JSON.parse(response) as { category?: string };
        return parsed.category && CATEGORY_SET.has(parsed.category)
          ? (parsed.category as Category)
          : 'Other';
      } catch {
        return 'Other';
      }
    };

    return { classify, dispose: () => session.dispose() };
  }
}
