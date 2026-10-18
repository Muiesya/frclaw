import { describe, expect, test } from 'vitest';

import { createAppForTest } from '../src/web.js';
import type { WebDeps } from '../src/web-context.js';

const app = createAppForTest({} as WebDeps);

describe('backend root route', () => {
  test('explains the API entry points instead of returning a blank 404', async () => {
    const response = await app.request('http://localhost/');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      name: 'FrClaw API',
      status: 'ok',
      health: '/api/health',
      finance: '/api/finance/longbridge/status',
    });
  });
});
