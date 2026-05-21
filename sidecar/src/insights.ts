import { LlamaChatSession } from 'node-llama-cpp';
import { buildBudgetReport, type BudgetReport } from './budget.js';
import type { LlmManager } from './llm.js';
import type { Repo } from './repo.js';

export interface InsightsStatus {
  state: 'idle' | 'generating' | 'ready' | 'error';
  text: string;
  generatedAt: string | null;
  message: string;
}

const SYSTEM_PROMPT =
  'You are a concise, friendly personal-finance assistant. Given a summary of ' +
  "this month's spending against budgets, write 3 to 4 short insights — one per " +
  'line. Be specific with categories and numbers. Call out overspending and good ' +
  'habits. No preamble, no markdown, no bullet characters — just the insight lines.';

/**
 * Generates plain-language budget insights with the on-device model. The
 * numbers are computed here; the model only phrases them.
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
      if (report.lines.length === 0) {
        this.fail('No spending this month yet — sync and categorize transactions first.');
        return;
      }

      const context = await model.createContext({ contextSize: 4096 });
      try {
        const session = new LlamaChatSession({
          contextSequence: context.getSequence(),
          systemPrompt: SYSTEM_PROMPT,
        });
        const text = await session.prompt(buildPrompt(report), { maxTokens: 320 });
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

function buildPrompt(report: BudgetReport): string {
  const lines = report.lines.map((line) => {
    const spent = Math.round(line.spent);
    if (line.budget == null) {
      return `- ${line.category}: spent ${spent} ${report.currency}, no budget set`;
    }
    const budget = Math.round(line.budget);
    const diff = spent - budget;
    const note = diff > 0 ? `over budget by ${diff}` : `${Math.abs(diff)} still left`;
    return `- ${line.category}: spent ${spent} of ${budget} ${report.currency} (${note})`;
  });
  return (
    `Month: ${report.month}. Currency: ${report.currency}.\n` +
    `Total spent ${Math.round(report.totalSpent)}, total budgeted ${Math.round(report.totalBudget)}.\n` +
    `By category:\n${lines.join('\n')}\n\n` +
    'Write the insights now.'
  );
}
