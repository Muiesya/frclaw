import { describe, expect, test } from 'vitest';

import {
  createLongbridgeFinanceService,
  type LongbridgeCredentials,
} from './longbridge-service.js';
import { createLongbridgeReadOnlyCapability } from './longbridge-agent-capability.js';

const credentials: LongbridgeCredentials = {
  appKey: 'app-key',
  appSecret: 'app-secret',
  accessToken: 'access-token',
};

describe('Longbridge Agent capability adapter', () => {
  test('turns a Longbridge quote into provenance-bearing Agent evidence', async () => {
    const service = createLongbridgeFinanceService({
      env: {},
      now: () => Date.parse('2026-09-16T09:00:00.000Z'),
      fetchQuotes: async (_actualCredentials, symbols) => [
        {
          symbol: symbols[0],
          lastDone: '512.4',
          prevClose: '500',
          open: '501',
          high: '514',
          low: '498.5',
          timestamp: new Date('2026-09-16T08:30:00.000Z'),
          volume: 123456,
          turnover: '63234567.89',
          tradeStatus: 'normal',
        },
      ],
    });
    const capability = createLongbridgeReadOnlyCapability({
      service,
      credentials,
    });

    const result = await capability.getQuote(
      { symbol: '0700', market: 'HK' },
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      status: 'complete',
      missing: [],
      evidence: [
        {
          symbol: '0700.HK',
          market: 'HK',
          metric: 'quote',
          asOf: '2026-09-16T08:30:00.000Z',
          retrievedAt: '2026-09-16T09:00:00.000Z',
          sourceId: 'longbridge:quote:0700.HK',
          sourceKind: 'longbridge_openapi',
          value: { last: 512.4, change: 12.4, changePercent: 2.48 },
        },
      ],
    });
  });

  test('marks missing credentials unavailable and never accepts them as input', async () => {
    const service = createLongbridgeFinanceService({
      env: {},
      now: () => Date.parse('2026-09-16T09:00:00.000Z'),
    });
    const capability = createLongbridgeReadOnlyCapability({ service });

    const result = await capability.getQuote(
      { symbol: '0700.HK', market: 'HK' },
      new AbortController().signal,
    );

    expect(result.status).toBe('provider_unavailable');
    expect(result.evidence).toEqual([]);
    expect(result.recovery).toContain('配置 Longbridge 凭据');
    expect(JSON.stringify(result)).not.toContain('app-secret');
    expect(JSON.stringify(result)).not.toContain('access-token');
  });

  test('keeps unsupported read-only operations explicit', async () => {
    const capability = createLongbridgeReadOnlyCapability({
      credentials,
    });

    const result = await capability.getPositions(
      {},
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      status: 'provider_unavailable',
      evidence: [],
      error: { code: 'unsupported_operation' },
    });
  });
});
