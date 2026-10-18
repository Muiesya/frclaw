import { afterEach, describe, expect, test, vi } from 'vitest';
import { createConfiguredResearchSynthesisProvider } from './research-synthesis-http.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.unstubAllEnvs();
  globalThis.fetch = originalFetch;
});

describe('configured research synthesis Provider', () => {
  test('is unavailable without complete configuration', () => {
    expect(createConfiguredResearchSynthesisProvider()).toBeUndefined();
  });

  test('parses an Anthropic JSON response without exposing the API key', async () => {
    vi.stubEnv('MINICLAW_RESEARCH_SYNTHESIS_PROVIDER', 'anthropic');
    vi.stubEnv('MINICLAW_RESEARCH_SYNTHESIS_URL', 'https://api.example.test');
    vi.stubEnv('MINICLAW_RESEARCH_SYNTHESIS_KEY', 'secret-key');
    vi.stubEnv('MINICLAW_RESEARCH_SYNTHESIS_MODEL', 'research-model');
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  summary: 'summary',
                  stance: 'neutral',
                  confidence: 'low',
                  bullArguments: [],
                  bearArguments: [],
                  catalysts: [],
                  risks: [],
                  gaps: [],
                  evidenceRefs: ['evidence-1'],
                }),
              },
            ],
          }),
          { status: 200 },
        ),
    );
    globalThis.fetch = request as unknown as typeof fetch;

    const provider = createConfiguredResearchSynthesisProvider()!;
    const result = await provider.generate({
      symbol: '0700.HK',
      question: '研究风险',
      gaps: [],
      evidence: [
        {
          id: 'evidence-1',
          metric: 'quote',
          sourceId: 'source-1',
          sourceKind: 'licensed_provider',
          asOf: '2026-09-16T09:00:00.000Z',
          retrievedAt: '2026-09-16T09:00:01.000Z',
          value: { last: 500 },
        },
      ],
    });

    expect(result).toMatchObject({
      stance: 'neutral',
      evidenceRefs: ['evidence-1'],
    });
    expect(JSON.stringify(result)).not.toContain('secret-key');
    expect(provider.id).toBe('anthropic:research-model');
  });
});
