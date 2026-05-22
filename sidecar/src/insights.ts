import { LlamaChatSession } from 'node-llama-cpp';
import { buildBudgetReport, type BudgetReport } from './budget.js';
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

  constructor(
    private readonly repo: Repo,
    private readonly llm: LlmManager,
  ) {}

  getStatus(): InsightsStatus {
    return this.status;
  }

  start(): void {
    if (this.status.state === 'generating') return;
    this.status = { ...this.status, state: 'generating', message: 'Generating insights…' };
    void this.run();
  }

  private async run(): Promise<void> {
    try {
      const model = this.llm.getModel();
      if (!model) {
        this.fail('Download the AI model first to generate insights.');
        return;
      }

      const report = buildBudgetReport(this.repo);
      if (report.totalSpent <= 0) {
        this.fail('No spending this month yet — sync and categorize transactions first.');
        return;
      }
      const analytics = buildAnalytics(this.repo);

      const context = await model.createContext({ contextSize: 4096 });
      try {
        const session = new LlamaChatSession({
          contextSequence: context.getSequence(),
          systemPrompt: SYSTEM_PROMPT,
        });
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
        context.dispose();
      }
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  private fail(message: string): void {
    this.status = { state: 'error', text: '', generatedAt: null, message };
  }
}

function buildPrompt(report: BudgetReport, a: Analytics): string {
  const trend =
    a.spendingChangePct == null
      ? 'no prior month to compare'
      : `${a.spendingChangePct >= 0 ? 'up' : 'down'} ` +
        `${Math.abs(Math.round(a.spendingChangePct))}% versus last month`;

  const cats = a.byCategory.slice(0, 8).map((c) => {
    const move =
      c.changePct == null
        ? 'nothing spent here last month'
        : `${c.changePct >= 0 ? '+' : ''}${Math.round(c.changePct)}% vs last month`;
    return `- ${c.category}: ${Math.round(c.amount)} ${a.currency} (${move})`;
  });

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

  const net = Math.round(a.thisMonth.income - a.thisMonth.spending);

  return (
    `Month: ${report.month}. Currency: ${report.currency}.\n` +
    `Spent ${Math.round(a.thisMonth.spending)} this month, ` +
    `${Math.round(a.lastMonth.spending)} last month (${trend}).\n` +
    `Income ${Math.round(a.thisMonth.income)} this month; ` +
    `net ${net >= 0 ? 'saved' : 'overspent'} ${Math.abs(net)} ${report.currency}.\n` +
    `Average expense ${Math.round(a.avgTransaction)} ${report.currency} over the past year.\n` +
    `Total spent ${Math.round(report.totalSpent)} ${report.currency} this month.\n\n` +
    `Spending by category this month:\n${cats.join('\n')}\n\n` +
    `Essential budgets:\n${essentials.length ? essentials.join('\n') : '- none set'}\n\n` +
    `${variableLine}\n\n` +
    'Write the 5-6 tagged insights now.'
  );
}
