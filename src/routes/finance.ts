import { Hono } from 'hono';
import { z } from 'zod';

import { authMiddleware } from '../middleware/auth.js';
import type { AuthUser } from '../types.js';
import type { Variables } from '../web-context.js';
import { createLongbridgeFinanceService } from '../finance/longbridge-service.js';
import {
  clearLongbridgeCredentialsForUser,
  getLongbridgeCredentialsForUser,
  setLongbridgeCredentialsForUser,
} from '../finance/longbridge-session.js';

const DEFAULT_SYMBOLS = ['0700.HK', '9988.HK', 'AAPL.US', 'TSLA.US'];

const LongbridgeCredentialsSchema = z.object({
  appKey: z.string().trim().min(1).max(2000),
  appSecret: z.string().trim().min(1).max(2000),
  accessToken: z.string().trim().min(1).max(2000),
});

const financeService = createLongbridgeFinanceService();
const financeRoutes = new Hono<{ Variables: Variables }>();

function getUser(c: { get: (key: 'user') => unknown }): AuthUser {
  return c.get('user') as AuthUser;
}

// GET /api/finance/longbridge/status - only exposes masked/non-secret state.
financeRoutes.get('/longbridge/status', authMiddleware, (c) => {
  const user = getUser(c);
  return c.json({
    provider: 'longbridge',
    connection: financeService.getStatus(
      getLongbridgeCredentialsForUser(user.id),
    ),
    capabilities: ['quote', 'security', 'positions', 'historical_orders'],
    tradingEnabled: false,
  });
});

// GET /api/finance/longbridge/quotes?symbols=0700.HK,AAPL.US&demo=1
financeRoutes.get('/longbridge/quotes', authMiddleware, async (c) => {
  const user = getUser(c);
  const rawSymbols = c.req.query('symbols');
  const symbols = rawSymbols ? rawSymbols.split(',') : DEFAULT_SYMBOLS;
  const demo = ['1', 'true'].includes(c.req.query('demo') ?? '');

  try {
    return c.json(
      await financeService.getQuotes(symbols, {
        credentials: getLongbridgeCredentialsForUser(user.id),
        demo,
      }),
    );
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Invalid symbols' },
      400,
    );
  }
});

// Credentials are held only in this backend process for the current user.
// They are never returned, logged, or written to the database by this route.
financeRoutes.put('/longbridge/config', authMiddleware, async (c) => {
  const user = getUser(c);
  const body = await c.req.json().catch(() => ({}));
  const validation = LongbridgeCredentialsSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: '请完整填写 Longbridge App Key、App Secret 和 Access Token。' },
      400,
    );
  }

  setLongbridgeCredentialsForUser(user.id, validation.data);
  return c.json({
    provider: 'longbridge',
    connection: financeService.getStatus(validation.data),
    tradingEnabled: false,
  });
});

financeRoutes.delete('/longbridge/config', authMiddleware, (c) => {
  const user = getUser(c);
  clearLongbridgeCredentialsForUser(user.id);
  return c.json({
    provider: 'longbridge',
    connection: financeService.getStatus(),
    tradingEnabled: false,
  });
});

export default financeRoutes;
