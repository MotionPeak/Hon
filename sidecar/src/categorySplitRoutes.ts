import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repo } from './repo.js';

const splitBody = z.object({ category: z.string().min(1), splitCount: z.number().int().nullable() });
const shareBody = z.object({ category: z.string().min(1), shareAmount: z.number().nullable() });

/**
 * Per-category split + share overrides. A category can be divided equally among
 * N people (split_count) and/or pinned to an absolute "my share" amount
 * (share_amount) — for uneven splits the divisor can't express (rent ₪7,500, I
 * pay ₪2,250). Extracted from server.ts, like registerVncProxy, so the routes
 * are unit-testable via app.inject without booting the engine. Bodies are
 * validated in-handler (not via the typed schema option) to keep this module
 * independent of the app's zod type-provider wiring.
 */
export function registerCategorySplitRoutes(
  app: FastifyInstance,
  getRepo: () => Repo | null,
): void {
  app.get('/category-splits', async (_req, reply) => {
    const repo = getRepo();
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    const splits: Record<string, number> = {};
    const shareAmounts: Record<string, number> = {};
    for (const row of repo.listCategorySplits()) {
      if (row.splitCount > 1) splits[row.category] = row.splitCount;
      if (row.shareAmount != null) shareAmounts[row.category] = row.shareAmount;
    }
    return { splits, shareAmounts };
  });

  // `splitCount: null` (or === 1) clears the divisor — business rule kept.
  app.put('/category-split', async (req, reply) => {
    const repo = getRepo();
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    const parsed = splitBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'category and splitCount are required' });
    const category = parsed.data.category.trim();
    const { splitCount } = parsed.data;
    if (!category) return reply.code(400).send({ error: 'a category is required' });
    if (splitCount == null || splitCount === 1) {
      repo.clearCategorySplit(category);
      return { ok: true };
    }
    if (splitCount < 1 || splitCount > 50) {
      return reply.code(400).send({ error: 'splitCount must be a whole number between 1 and 50' });
    }
    repo.setCategorySplit(category, splitCount);
    return { ok: true };
  });

  // Absolute "my share" override. `shareAmount: null` (or <= 0) clears it.
  app.put('/category-share', async (req, reply) => {
    const repo = getRepo();
    if (!repo) return reply.code(503).send({ error: 'database unavailable' });
    const parsed = shareBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'category and shareAmount are required' });
    const category = parsed.data.category.trim();
    const { shareAmount } = parsed.data;
    if (!category) return reply.code(400).send({ error: 'a category is required' });
    if (shareAmount == null || shareAmount <= 0) {
      repo.clearCategoryShareAmount(category);
      return { ok: true };
    }
    if (shareAmount > 1_000_000) {
      return reply.code(400).send({ error: 'shareAmount is unreasonably large' });
    }
    repo.setCategoryShareAmount(category, shareAmount);
    return { ok: true };
  });
}
