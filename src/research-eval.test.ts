import { describe, expect, test } from 'vitest';
import {
  evaluateResearchGoldenCase,
  evaluateResearchSnapshot,
  RESEARCH_GOLDEN_CASES,
  type ResearchEvalSnapshot,
} from './research-eval.js';

const evidence = {
  id: 'evidence_quote',
  stepId: 'step_quote',
  symbol: '0700.HK',
  metric: 'quote',
  sourceId: 'demo:quote:0700.HK',
  sourceKind: 'demo_fixture',
  asOf: '2026-09-16T09:00:00.000Z',
  retrievedAt: '2026-09-16T09:00:01.000Z',
  retrievalLatencySeconds: 1,
  ageSeconds: 1,
  maxAgeSeconds: 3600,
  isStale: false,
  value: { last: 512.4 },
};

function snapshot(
  overrides: Partial<ResearchEvalSnapshot>,
): ResearchEvalSnapshot {
  return {
    status: 'partial',
    steps: [
      {
        id: 'step_quote',
        capability: 'quote',
        provider: 'longbridge',
        status: 'completed',
        attempt: 1,
      },
      {
        id: 'step_news',
        capability: 'news',
        provider: 'not_configured',
        status: 'provider_unavailable',
        attempt: 1,
      },
    ],
    evidence: [evidence],
    report: {
      version: 1,
      generatedAt: '2026-09-16T09:00:01.000Z',
      status: 'partial',
      symbol: '0700.HK',
      question: '研究风险',
      summary: '部分数据',
      stance: 'neutral',
      confidence: 'low',
      bullArguments: [],
      bearArguments: [],
      catalysts: [],
      risks: [],
      gaps: ['news'],
      evidenceRefs: ['evidence_quote'],
    },
    ...overrides,
  };
}

describe('research golden evaluation', () => {
  test('accepts honest partial evidence and rejects fake unavailable evidence', () => {
    expect(evaluateResearchSnapshot(snapshot({})).passed).toBe(true);
    expect(
      evaluateResearchSnapshot(
        snapshot({ evidence: [{ ...evidence, stepId: 'step_news' }] }),
      ).passed,
    ).toBe(false);
  });

  test('golden cases encode the status/report contract', () => {
    const partial = RESEARCH_GOLDEN_CASES.find(
      (item) => item.id === 'quote-plus-provider-gaps',
    )!;
    expect(evaluateResearchGoldenCase(partial, snapshot({})).passed).toBe(true);
  });
});
