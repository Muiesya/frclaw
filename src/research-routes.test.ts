import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Database from './sqlite-compat.js';
import {
  executeResearchRun,
  type getResearchRunView,
} from './research-service.js';
import {
  bindResearchDatabase,
  createResearchSchema,
} from './research-store.js';
import researchRoutes from './routes/research.js';

vi.mock('./middleware/auth.js', () => ({
  authMiddleware: async (
    c: { set: (key: string, value: { id: string }) => void },
    next: () => Promise<void>,
  ) => {
    c.set('user', { id: 'research-user' });
    await next();
  },
}));

const app = new Hono().route('/api/research', researchRoutes);
let database: InstanceType<typeof Database>;

beforeEach(() => {
  database = new Database(':memory:');
  createResearchSchema(database);
  bindResearchDatabase(database);
});

afterEach(() => database.close());

function createRun(scenario?: string) {
  return app.request('/api/research/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol: '0700.HK',
      question: '研究公开信息',
      scenario,
    }),
  });
}

async function readRun(response: Response) {
  const body = (await response.json()) as {
    run: NonNullable<ReturnType<typeof getResearchRunView>>;
  };
  return body.run;
}

describe('research scenarios', () => {
  test.each([
    [undefined, ['quote', 'fundamentals', 'valuation', 'news']],
    ['quote', ['quote']],
    ['earnings', ['quote', 'fundamentals']],
    ['events', ['quote', 'news']],
  ])('materializes only the steps for %s', async (scenario, capabilities) => {
    const response = await createRun(scenario);
    expect(response.status).toBe(202);
    const run = await readRun(response);
    expect(
      run.steps.map((step: { capability: string }) => step.capability),
    ).toEqual(capabilities);
    expect(run.plan.scenario).toBe(scenario ?? 'full');
    expect(run.plan.execution?.budgetUnits).toBe(capabilities.length);
    expect(run.steps[0].parameters.symbol).toBe('0700.HK');
  });

  test('rejects unknown scenarios', async () => {
    expect((await createRun('unsupported')).status).toBe(400);
  });

  test('runs and resumes quote-only from its saved plan', async () => {
    const run = await readRun(await createRun('quote'));
    await executeResearchRun(run.id);
    const first = await readRun(
      await app.request(`/api/research/runs/${run.id}`),
    );
    const attempts = (events: { eventType: string }[]) =>
      events.filter((event) => event.eventType === 'capability_started');
    expect(attempts(first.audit)).toHaveLength(1);
    expect(first.report?.gaps).toHaveLength(1);

    const response = await app.request(`/api/research/runs/${run.id}/resume`, {
      method: 'POST',
    });
    expect(response.status).toBe(202);
    const resumed = await readRun(response);
    expect(resumed.plan).toEqual(run.plan);
    expect(resumed.steps.map((step: { id: string }) => step.id)).toEqual([
      run.steps[0].id,
    ]);

    const review = await app.request(`/api/research/runs/${run.id}/review`, {
      method: 'POST',
    });
    expect(review.status).toBe(202);
    const reviewed = await readRun(review);
    expect(reviewed.id).not.toBe(run.id);
    expect(reviewed.plan.scenario).toBe('quote');
    expect(reviewed.steps).toHaveLength(1);
  });
});
