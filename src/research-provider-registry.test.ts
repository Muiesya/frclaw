import { describe, expect, test } from 'vitest';
import { createResearchCapabilityRegistry } from './research-provider-registry.js';

const signal = new AbortController().signal;

describe('research provider routing contract', () => {
  test('routes every planned capability without fabricating unavailable evidence', async () => {
    const registry = createResearchCapabilityRegistry('missing-user');
    const fundamentals = registry.get('fundamentals', 'not_configured');
    const result = await fundamentals.execute(
      {
        symbol: '0700.HK',
        market: 'HK',
        question: '研究风险',
        parameters: { symbol: '0700.HK' },
      },
      signal,
    );

    expect(result.status).toBe('provider_unavailable');
    expect(result.evidence).toEqual([]);
    expect(result.missing).toEqual(['fundamentals']);
    expect(registry.statuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'not_configured',
          health: 'unavailable',
          capabilities: ['fundamentals', 'valuation', 'news'],
        }),
      ]),
    );
  });
});
