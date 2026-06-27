import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { openDatabase } from '../src/db.js';
import { Repo } from '../src/repo.js';
import { registerCategorySplitRoutes } from '../src/categorySplitRoutes.js';

function buildApp() {
  const dir = mkdtempSync(join(tmpdir(), 'hon-split-route-'));
  const { db } = openDatabase(dir);
  const repo = new Repo(db);
  const app = Fastify();
  registerCategorySplitRoutes(app, () => repo);
  return { app, repo };
}

describe('/category-share + /category-splits', () => {
  it('PUT sets a share and GET returns it', async () => {
    const { app } = buildApp();
    await app.ready();
    const put = await app.inject({ method: 'PUT', url: '/category-share', payload: { category: 'Housing', shareAmount: 2250 } });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: '/category-splits' });
    expect(get.json()).toMatchObject({ shareAmounts: { Housing: 2250 } });
    await app.close();
  });

  it('PUT null clears the share', async () => {
    const { app } = buildApp();
    await app.ready();
    await app.inject({ method: 'PUT', url: '/category-share', payload: { category: 'Housing', shareAmount: 2250 } });
    await app.inject({ method: 'PUT', url: '/category-share', payload: { category: 'Housing', shareAmount: null } });
    const get = await app.inject({ method: 'GET', url: '/category-splits' });
    expect(get.json().shareAmounts).toEqual({});
    await app.close();
  });

  it('GET returns splits (>1) and shares together', async () => {
    const { app, repo } = buildApp();
    repo.setCategorySplit('Utilities', 3);
    repo.setCategoryShareAmount('Housing', 2250);
    await app.ready();
    const get = await app.inject({ method: 'GET', url: '/category-splits' });
    expect(get.json()).toEqual({ splits: { Utilities: 3 }, shareAmounts: { Housing: 2250 } });
    await app.close();
  });
});
