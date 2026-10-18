import { afterEach, describe, expect, test, vi } from 'vitest';
import { createConfiguredResearchHttpCapabilities } from './research-http-providers.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.unstubAllEnvs();
  globalThis.fetch = originalFetch;
});

describe('configured research HTTP Providers', () => {
  test('uses a fallback after the primary endpoint fails', async () => {
    vi.stubEnv(
      'MINICLAW_FUNDAMENTALS_PROVIDER_URL',
      'https://primary.test/fundamentals',
    );
    vi.stubEnv(
      'MINICLAW_FUNDAMENTALS_FALLBACK_URL',
      'https://backup.test/fundamentals',
    );
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'complete',
            evidence: [
              {
                symbol: '0700.HK',
                market: 'HK',
                metric: 'revenue',
                value: 660,
                unit: 'HKD',
                asOf: '2025-12-31T00:00:00.000Z',
                retrievedAt: '2026-10-17T09:00:00.000Z',
                sourceId: 'backup:revenue:0700.HK',
                sourceKind: 'licensed_provider',
              },
            ],
            missing: [],
            conflicts: [],
          }),
          { status: 200 },
        ),
      );
    globalThis.fetch = fetcher as unknown as typeof fetch;

    const configured = createConfiguredResearchHttpCapabilities()[0]!;
    const result = await configured.capabilityAdapter.execute(
      {
        symbol: '0700.HK',
        market: 'HK',
        question: '研究财务',
        parameters: {},
      },
      new AbortController().signal,
    );

    expect(result.status).toBe('complete');
    expect(result.evidence[0]?.sourceId).toBe('backup:revenue:0700.HK');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('rejects non-HTTPS endpoints before making a request', async () => {
    vi.stubEnv('MINICLAW_NEWS_PROVIDER_URL', 'http://news.test/news');
    const configured = createConfiguredResearchHttpCapabilities()[0]!;
    await expect(
      configured.capabilityAdapter.execute(
        {
          symbol: '0700.HK',
          market: 'HK',
          question: '研究公告',
          parameters: {},
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      evidence: [],
    });
  });
});
