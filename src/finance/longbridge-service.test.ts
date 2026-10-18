import { describe, expect, test } from 'vitest';

import {
  createLongbridgeFinanceService,
  type LongbridgeCredentials,
  type LongbridgeSdkQuote,
} from './longbridge-service.js';

const credentials: LongbridgeCredentials = {
  appKey: 'app-key',
  appSecret: 'app-secret',
  accessToken: 'access-token',
};

const sdkQuote: LongbridgeSdkQuote = {
  symbol: '0700.HK',
  lastDone: '512.4',
  prevClose: '500.0',
  open: '501.0',
  high: '514.0',
  low: '498.5',
  timestamp: new Date('2026-09-16T08:30:00.000Z'),
  volume: 123456,
  turnover: '63234567.89',
  tradeStatus: 'normal',
};

describe('Longbridge finance service', () => {
  test('returns unavailable without credentials and requires explicit demo mode', async () => {
    const service = createLongbridgeFinanceService({
      env: {},
      now: () => Date.parse('2026-09-16T09:00:00.000Z'),
    });

    expect(service.getStatus()).toMatchObject({
      configured: false,
      mode: 'demo',
      source: 'demo',
    });

    const result = await service.getQuotes(['0700.HK']);
    expect(result.status).toBe('provider_unavailable');
    expect(result.quotes).toEqual([]);

    const demo = await service.getQuotes(['0700.HK'], { demo: true });
    expect(demo.status).toBe('demo');
    expect(demo.quotes[0]).toMatchObject({
      symbol: '0700.HK',
      market: 'HK',
      source: 'demo',
    });
  });

  test('normalizes live SDK quotes and preserves evidence timestamps', async () => {
    let requestedSymbols: string[] = [];
    const service = createLongbridgeFinanceService({
      env: {},
      now: () => Date.parse('2026-09-16T09:00:00.000Z'),
      fetchQuotes: async (_actualCredentials, symbols) => {
        requestedSymbols = symbols;
        return [sdkQuote];
      },
    });

    const result = await service.getQuotes([' 0700.hk ', '0700.HK'], {
      credentials,
    });

    expect(requestedSymbols).toEqual(['0700.HK']);
    expect(result.status).toBe('live');
    expect(result.quotes[0]).toMatchObject({
      symbol: '0700.HK',
      last: 512.4,
      prevClose: 500,
      change: 12.4,
      changePercent: 2.48,
      asOf: '2026-09-16T08:30:00.000Z',
      retrievedAt: '2026-09-16T09:00:00.000Z',
      source: 'longbridge',
      evidenceStatus: 'complete',
    });
  });

  test('turns provider failures into a safe unavailable result', async () => {
    const service = createLongbridgeFinanceService({
      env: {},
      fetchQuotes: async () => {
        throw new Error('secret-bearing provider error');
      },
    });

    const result = await service.getQuotes(['AAPL.US'], { credentials });
    expect(result.status).toBe('provider_unavailable');
    expect(result.message).toBe(
      'Longbridge 数据暂不可用，请检查连接配置后重试。',
    );
    expect(JSON.stringify(result)).not.toContain('secret-bearing');
  });

  test('rejects an empty symbol list before calling the provider', async () => {
    const service = createLongbridgeFinanceService({ env: {} });
    await expect(service.getQuotes(['', '  '])).rejects.toThrow(
      '至少输入一个证券代码',
    );
  });
});
