import { describe, expect, test } from 'vitest';

import {
  FINANCE_READ_ONLY_TOOL_NAMES,
  createLongbridgeReadOnlyTools,
  type LongbridgeReadOnlyCapability,
} from '../src/finance/finance-tools.js';
import type {
  FinanceFreshnessPolicy,
  FinanceToolResult,
} from '../src/finance/finance-evidence.js';

const completeResult: FinanceToolResult = {
  status: 'complete',
  evidence: [
    {
      symbol: '0700',
      market: 'HK',
      asOf: '2026-09-16T07:59:00.000Z',
      retrievedAt: '2026-09-16T08:00:00.000Z',
      sourceId: 'longbridge:quote:0700:HK',
      sourceKind: 'longbridge',
      metric: 'last_price',
      value: 512.5,
      unit: 'HKD',
    },
  ],
  missing: [],
  conflicts: [],
};

const freshness: FinanceFreshnessPolicy = {
  now: () => Date.parse('2026-09-16T08:00:00.000Z'),
  maxAgeMs: 5 * 60_000,
};

function textPayload(result: {
  content: Array<{ type: string; text?: string }>;
}) {
  const block = result.content[0];
  if (!block || block.type !== 'text' || typeof block.text !== 'string') {
    throw new Error('Expected a text MCP result');
  }
  return JSON.parse(block.text) as FinanceToolResult;
}

function baseCapability(): LongbridgeReadOnlyCapability {
  return {
    getQuote: async () => completeResult,
    getSecurity: async () => completeResult,
    getPositions: async () => completeResult,
    getHistoricalOrders: async () => completeResult,
  };
}

describe('Longbridge read-only finance tools', () => {
  test('exposes exactly the read-only allowlist and no trade operations', () => {
    const tools = createLongbridgeReadOnlyTools(baseCapability(), freshness);
    const names = tools.map((item) => item.name);

    expect(names).toEqual([...FINANCE_READ_ONLY_TOOL_NAMES]);
    expect(names).not.toContain('submit_order');
    expect(names).not.toContain('cancel_order');
    expect(names).not.toContain('amend_order');
  });

  test('maps quote input to the capability and preserves structured evidence', async () => {
    let received: { symbol: string; market: string } | undefined;
    const capability: LongbridgeReadOnlyCapability = {
      ...baseCapability(),
      getQuote: async (input) => {
        received = input;
        return completeResult;
      },
    };

    const tool = createLongbridgeReadOnlyTools(capability, freshness).find(
      (item) => item.name === 'longbridge_get_quote',
    );
    if (!tool) throw new Error('Quote tool was not registered');

    const payload = textPayload(
      await tool.handler({ symbol: '0700', market: 'HK' }, {}),
    );

    expect(received).toEqual({ symbol: '0700', market: 'HK' });
    expect(payload.status).toBe('complete');
    expect(payload.evidence[0]?.sourceId).toBe('longbridge:quote:0700:HK');
  });

  test('converts provider exceptions into a safe unavailable result', async () => {
    const capability: LongbridgeReadOnlyCapability = {
      ...baseCapability(),
      getQuote: async () => {
        throw new Error('access_token=must-not-leak');
      },
    };
    const tool = createLongbridgeReadOnlyTools(capability, freshness).find(
      (item) => item.name === 'longbridge_get_quote',
    );
    if (!tool) throw new Error('Quote tool was not registered');

    const result = await tool.handler({ symbol: '0700', market: 'HK' }, {});
    const payload = textPayload(result);

    expect(result.isError).toBe(true);
    expect(payload.status).toBe('provider_unavailable');
    expect(JSON.stringify(payload)).not.toContain('access_token');
    expect(payload.recovery).toBeTruthy();
  });

  test('preserves a partial result and its missing fields', async () => {
    const capability: LongbridgeReadOnlyCapability = {
      ...baseCapability(),
      getSecurity: async () => ({
        ...completeResult,
        status: 'partial',
        missing: ['industry'],
      }),
    };
    const tool = createLongbridgeReadOnlyTools(capability, freshness).find(
      (item) => item.name === 'longbridge_get_security',
    );
    if (!tool) throw new Error('Security tool was not registered');

    const payload = textPayload(
      await tool.handler({ symbol: '0700', market: 'HK' }, {}),
    );

    expect(payload.status).toBe('partial');
    expect(payload.missing).toEqual(['industry']);
  });

  test('rejects an empty symbol at the tool schema boundary', () => {
    const tool = createLongbridgeReadOnlyTools(baseCapability(), freshness)[0];
    if (!tool) throw new Error('Quote tool was not registered');

    expect(() => tool.inputSchema.symbol.parse('')).toThrow();
  });
});
