import { buildBudgetReport, type BudgetReport, type MonthRange } from './budget.js';
import { buildAnalytics, type Analytics } from './analytics.js';
import type { LlmManager } from './llm.js';
import type { Repo } from './repo.js';

export interface InsightsStatus {
  state: 'idle' | 'generating' | 'ready' | 'error';
  text: string;
  generatedAt: string | null;
  message: string;
}

const SYSTEM_PROMPT =
  'You are a sharp, encouraging personal-finance analyst. You receive a ' +
  "summary of this month's spending, how each category moved versus last " +
  'month, and the budget targets. Write 5 or 6 punchy insights, one per line. ' +
  'Begin EVERY line with one tag in capital letters followed by a colon, ' +
  'chosen from exactly these four:\n' +
  'WIN: a real good habit, a saving, or a category comfortably under budget.\n' +
  'WATCH: overspending, an over-budget category, or a concerning increase.\n' +
  'TREND: a notable month-over-month shift or spending pattern.\n' +
  'TIP: one specific, actionable suggestion.\n' +
  'Name real categories and real numbers from the data. Keep each line to one ' +
  'sentence. No markdown, no bullet characters, no preamble — output only the ' +
  'tagged lines.';

/**
 * Generates tagged personal-finance insights with the on-device model. The
 * numbers are computed here; the model phrases them and assigns each line a
 * WIN / WATCH / TREND / TIP tag that the web app renders as a coloured card.
 */
export class InsightsGenerator {
  private status: InsightsStatus = {
    state: 'idle',
    text: '',
    generatedAt: null,
    message: 'No insights generated yet.',
  };
  private cardProviders: string[] = [];
  private range: MonthRange | undefined;

  constructor(
    private readonly repo: Repo,
    private readonly llm: LlmManager,
  ) {}

  getStatus(): InsightsStatus {
    return this.status;
  }

  start(cardProviders: string[] = [], range?: MonthRange): void {
    if (this.status.state === 'generating') return;
    this.cardProviders = cardProviders;
    this.range = range;
    this.status = { ...this.status, state: 'generating', message: 'Generating insights…' };
    void this.run();
  }

  private async run(): Promise<void> {
    try {
      if (!this.llm.isReady()) {
        this.fail('Set up an AI model first to generate insights.');
        return;
      }

      // Use the user's billing-cycle range (when the client supplied it) so the
      // insight's "this month" figures match the Budget tab instead of diverging
      // on a calendar month near a custom cycle boundary.
      const report = buildBudgetReport(this.repo, this.range, { cardProviders: this.cardProviders });
      const analytics = buildAnalytics(this.repo, this.cardProviders);
      // Abort only when there's genuinely nothing to talk about. `totalSpent`
      // counts CATEGORIZED spend only, so on its own it reads 0 when the user
      // has spent but not yet categorized — aborting spuriously. Fold in the
      // analytics monthly total (which includes uncategorized spend) so a fresh,
      // uncategorized month still produces insights.
      if (report.totalSpent <= 0 && analytics.thisMonth.spending <= 0) {
        this.fail('No spending this month yet — sync and categorize transactions first.');
        return;
      }

      const session = await this.llm.openSession({
        system: SYSTEM_PROMPT,
        contextSize: 4096,
      });
      try {
        const text = await session.prompt(buildPrompt(report, analytics), {
          maxTokens: 480,
        });
        this.status = {
          state: 'ready',
          text: text.trim(),
          generatedAt: new Date().toISOString(),
          message: '',
        };
      } finally {
        session.dispose();
      }
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  private fail(message: string): void {
    this.status = { state: 'error', text: '', generatedAt: null, message };
  }
}

/** "up 12%" / "down 5%". */
function trendPhrase(pct: number | null): string {
  if (pct == null) return 'no prior month to compare';
  return `${pct >= 0 ? 'up' : 'down'} ${Math.abs(Math.round(pct))}%`;
}

/** "+8% vs last month" / "-3% vs last month" for a single category. */
function categoryMovePhrase(pct: number | null): string {
  if (pct == null) return 'nothing spent here last month';
  return `${pct >= 0 ? '+' : ''}${Math.round(pct)}% vs last month`;
}

function buildPrompt(report: BudgetReport, a: Analytics): string {
  const trend = trendPhrase(a.spendingChangePct);
  const cats = a.byCategory.slice(0, 8).map(
    (c) => `- ${c.category}: ${Math.round(c.amount)} ${a.currency} (${categoryMovePhrase(c.changePct)})`,
  );

  const essentials = report.essentials.map((line) => {
    const spent = Math.round(line.spent);
    if (line.budget == null) {
      return `- ${line.category}: spent ${spent} ${report.currency}, no budget set`;
    }
    const budget = Math.round(line.budget);
    const diff = spent - budget;
    const note = diff > 0 ? `over budget by ${diff}` : `${Math.abs(diff)} still left`;
    return `- ${line.category}: spent ${spent} of ${budget} ${report.currency} (${note})`;
  });

  const v = report.variable;
  const variableNote =
    v.allowed >= 0
      ? `${Math.round(v.allowed)} still allowed`
      : `${Math.round(-v.allowed)} beyond what income allows`;
  const variableLine =
    'Variable / discretionary spending is computed, not set by hand: ' +
    `${Math.round(v.income)} ${report.currency} came in, ` +
    `${Math.round(v.committed)} covered fixed bills and essentials, leaving ` +
    `${Math.round(v.disposable)} for discretionary spending; ` +
    `${Math.round(v.spent)} spent so far (${variableNote}).`;

  // The absolute "this cycle" figures and the budgets below come from the
  // budget report, so they all sit on ONE basis — the user's billing cycle
  // (`report.month`). The category list and trend come from `analytics`, which
  // is a fixed CALENDAR-month series; it is presented purely as a
  // month-over-month comparison and labelled as such. The previous prompt mixed
  // analytics' absolute calendar-month total in as "this month" alongside the
  // cycle's `totalSpent`, so the two "spent this month" numbers contradicted
  // each other whenever the cycle boundary wasn't the 1st.
  const income = Math.round(v.income);
  const spent = Math.round(report.totalSpent);
  const net = income - spent;

  return (
    `Cycle: ${report.month}. Currency: ${report.currency}.\n` +
    `Spent ${spent} ${report.currency} this cycle on ${income} of income; ` +
    `net ${net >= 0 ? 'saved' : 'overspent'} ${Math.abs(net)} ${report.currency}.\n` +
    `Total spending is ${trend} versus the prior calendar month.\n` +
    `Average expense ${Math.round(a.avgTransaction)} ${report.currency} over the past year.\n\n` +
    `Spending by category (calendar month, vs the one before):\n${cats.join('\n')}\n\n` +
    `Essential budgets this cycle:\n${essentials.length ? essentials.join('\n') : '- none set'}\n\n` +
    `${variableLine}\n\n` +
    'Write the 5-6 tagged insights now.'
  );
}
