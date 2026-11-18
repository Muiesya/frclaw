import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthUser } from '../types.js';
import type { Variables } from '../web-context.js';
import {
  createResearchPlan,
  normalizeResearchSymbol,
  RESEARCH_SCENARIOS,
} from '../research-model.js';
import {
  cancelResearchRunDurable,
  createResearchRun,
  enqueueResearchRun,
  getResearchRunForUser,
  listResearchRuns,
} from '../research-store.js';
import {
  cancelResearchRun,
  getResearchRunView,
  isResearchRunActive,
  resumeResearchRun,
} from '../research-service.js';

const researchRoutes = new Hono<{ Variables: Variables }>();

const CreateResearchSchema = z.object({
  symbol: z.string().trim().min(1).max(50),
  market: z.string().trim().max(10).optional(),
  question: z.string().trim().min(1).max(2000),
  scenario: z.enum(RESEARCH_SCENARIOS).default('full'),
});

function userId(c: { get: (key: 'user') => unknown }): string {
  return (c.get('user') as AuthUser).id;
}

researchRoutes.get('/runs', authMiddleware, (c) => {
  return c.json({ runs: listResearchRuns(userId(c)) });
});

researchRoutes.post('/runs', authMiddleware, async (c) => {
  const parsed = CreateResearchSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json(
      {
        error: '请检查证券代码、研究问题和研究类型。',
        details: parsed.error.format(),
      },
      400,
    );
  }

  let symbol: string;
  try {
    symbol = normalizeResearchSymbol(parsed.data.symbol, parsed.data.market);
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : '证券代码无效。' },
      400,
    );
  }
  if (!symbol.endsWith('.HK')) {
    return c.json({ error: '第一阶段仅支持港股代码，例如 0700.HK。' }, 400);
  }

  const requestIdempotencyKey = c.req.header('Idempotency-Key');
  if (requestIdempotencyKey && requestIdempotencyKey.length > 200) {
    return c.json({ error: 'Idempotency-Key 过长。' }, 400);
  }
  const run = createResearchRun({
    userId: userId(c),
    symbol,
    question: parsed.data.question,
    plan: createResearchPlan(undefined, parsed.data.scenario),
    idempotencyKey: requestIdempotencyKey,
  });
  enqueueResearchRun(run.id);
  return c.json({ run: getResearchRunView(run.id) }, 202);
});

researchRoutes.get('/runs/:id', authMiddleware, (c) => {
  const run = getResearchRunForUser(c.req.param('id'), userId(c));
  if (!run) return c.json({ error: '研究运行不存在。' }, 404);
  return c.json({ run: getResearchRunView(run.id) });
});

researchRoutes.post('/runs/:id/cancel', authMiddleware, (c) => {
  const run = getResearchRunForUser(c.req.param('id'), userId(c));
  if (!run) return c.json({ error: '研究运行不存在。' }, 404);
  if (
    ![
      'planned',
      'queued',
      'retry_wait',
      'uncertain',
      'manual_reconciliation',
      'running',
    ].includes(run.status)
  ) {
    return c.json({ run: getResearchRunView(run.id) });
  }
  cancelResearchRun(run.id);
  if (run.status !== 'running' || !isResearchRunActive(run.id)) {
    cancelResearchRunDurable(run.id);
  }
  return c.json({ run: getResearchRunView(run.id) });
});

researchRoutes.post('/runs/:id/review', authMiddleware, (c) => {
  const source = getResearchRunForUser(c.req.param('id'), userId(c));
  if (!source) return c.json({ error: '研究运行不存在。' }, 404);
  const run = createResearchRun({
    userId: userId(c),
    symbol: source.symbol,
    question: source.question,
    plan: createResearchPlan(undefined, source.plan.scenario),
    idempotencyKey: c.req.header('Idempotency-Key'),
  });
  enqueueResearchRun(run.id);
  return c.json({ run: getResearchRunView(run.id) }, 202);
});

researchRoutes.post('/runs/:id/resume', authMiddleware, (c) => {
  const run = getResearchRunForUser(c.req.param('id'), userId(c));
  if (!run) return c.json({ error: '研究运行不存在。' }, 404);
  if (run.status === 'running' && isResearchRunActive(run.id)) {
    return c.json({ error: '研究运行仍在执行中。' }, 409);
  }
  resumeResearchRun(run.id);
  return c.json({ run: getResearchRunView(run.id) }, 202);
});

export default researchRoutes;
