// Categories API module — owns every /categories endpoint call. Components and
// query hooks call THESE functions, never `api('/categories', …)` inline, so
// the route URLs, HTTP verbs and payload shapes live in one place. Request
// bodies are typed by the SHARED zod schemas (the same ones the engine
// validates against and the react-hook-form resolver uses), and list responses
// are parsed through `categorySchema` so a backend/ём frontend shape drift fails
// loudly in dev instead of silently rendering wrong data.

import { z } from 'zod';
import {
  categorySchema,
  catGroupSchema,
  type Category,
  type CategoryCreate,
  type CategoryUpdate,
} from '@hon/shared/category';
import { api } from './client';

// The GET list is the canonical read, parsed STRICTLY through the shared schema
// so backend/frontend shape drift fails loudly in dev — EXCEPT catGroup, which
// falls back to 'variable' for any unrecognised value. The DB column is free
// text, so one legacy/out-of-enum group must degrade one row, not throw and
// blank the entire categories UI.
const listCategorySchema = categorySchema.extend({
  catGroup: catGroupSchema.catch('variable'),
});
const categoriesResponse = z.object({ categories: z.array(listCategorySchema) });
// POST/PUT echo the saved row for convenience, but the source of truth is the
// list query that the mutation invalidates. Parse the echo LENIENTLY (passthrough
// so a partial echo from a test/older engine doesn't reject the mutation).
const categoryEcho = z.object({ category: z.looseObject({ name: z.string() }) });

/** GET /categories → the full category set (built-ins + custom). */
export async function listCategories(): Promise<Category[]> {
  const data = await api<unknown>('/categories');
  return categoriesResponse.parse(data).categories;
}

/** POST /categories — create a custom category. Returns the saved name; the
 *  canonical row arrives via the invalidated list query. */
export async function createCategory(input: CategoryCreate): Promise<{ name: string }> {
  const data = await api<unknown>('/categories', 'POST', input);
  return { name: categoryEcho.parse(data).category.name };
}

/** PUT /categories/:name — partial update (emoji/colour/group/sortOrder). */
export async function updateCategory(name: string, patch: CategoryUpdate): Promise<{ name: string }> {
  const data = await api<unknown>(`/categories/${encodeURIComponent(name)}`, 'PUT', patch);
  return { name: categoryEcho.parse(data).category.name };
}

/** DELETE /categories/:name — reassigns its transactions to 'Other'. Returns
 *  how many transactions were moved (for the confirm dialog). */
export async function deleteCategory(name: string): Promise<{ transactionsMoved: number }> {
  const data = await api<{ ok: boolean; transactionsMoved?: number }>(
    `/categories/${encodeURIComponent(name)}`,
    'DELETE',
  );
  return { transactionsMoved: data.transactionsMoved ?? 0 };
}
