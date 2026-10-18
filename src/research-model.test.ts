import { describe, expect, test } from 'vitest';
import {
  ageSeconds,
  buildResearchReport,
  createResearchPlan,
  deriveResearchRunStatus,
  isResearchEvidenceStale,
  normalizeResearchSymbol,
  retrievalLatencySeconds,
  validateResearchReportEvidence,
} from './research-model.js';

describe('Folio research model', () => {
  test('normalizes exchange-qualified symbols without inventing a market', () => {
    expect(normalizeResearchSymbol('0700', 'hk')).toBe('0700.HK');
    expect(normalizeResearchSymbol(' AAPL.us ')).toBe('AAPL.US');
    expect(() => normalizeResearchSymbol('0700')).toThrow('市场代码');
  });

  test('plans configured and explicit provider gaps', () => {
    const plan = createResearchPlan('2026-09-16T09:00:00.000Z');
    expect(plan.capabilities.map((item) => item.capability)).toEqual([
      'quote',
      'fundamentals',
      'valuation',
      'news',
    ]);
    expect(
      plan.capabilities.find((item) => item.capability === 'quote')?.provider,
    ).toBe('longbridge');
    expect(
      plan.capabilities.find((item) => item.capability === 'news')?.provider,
    ).toBe('not_configured');
  });

  test('separates retrieval latency from data age and stale state', () => {
    expect(
      retrievalLatencySeconds(
        '2026-09-16T09:00:00.000Z',
        '2026-09-16T09:00:02.000Z',
      ),
    ).toBe(2);
    const now = Date.parse('2026-09-16T10:00:00.000Z');
    expect(ageSeconds('2026-09-16T09:00:00.000Z', now)).toBe(3600);
    expect(isResearchEvidenceStale('2026-09-16T09:00:00.000Z', 1800, now)).toBe(
      true,
    );
    expect(isResearchEvidenceStale(null, 1800, now)).toBeNull();
    expect(retrievalLatencySeconds(null, 'not-a-date')).toBeNull();
  });

  test('keeps run status semantics distinct', () => {
    expect(
      deriveResearchRunStatus({
        stepStatuses: ['completed', 'completed'],
        evidenceCount: 2,
      }),
    ).toBe('completed');
    expect(
      deriveResearchRunStatus({
        stepStatuses: ['completed', 'provider_unavailable'],
        evidenceCount: 1,
      }),
    ).toBe('partial');
    expect(
      deriveResearchRunStatus({
        stepStatuses: ['failed', 'provider_unavailable'],
        evidenceCount: 0,
      }),
    ).toBe('failed');
    expect(
      deriveResearchRunStatus({
        stepStatuses: ['completed'],
        evidenceCount: 1,
        cancelled: true,
      }),
    ).toBe('cancelled');
  });

  test('report references evidence IDs and preserves missing-data gaps', () => {
    const report = buildResearchReport({
      symbol: '0700.HK',
      question: '当前研究风险是什么？',
      generatedAt: '2026-09-16T09:00:00.000Z',
      status: 'partial',
      evidence: [
        {
          id: 'evidence_1',
          stepId: 'step_1',
          symbol: '0700.HK',
          metric: 'quote',
          sourceId: 'demo:quote:0700.HK',
          sourceKind: 'demo_fixture',
          asOf: '2026-09-16T09:00:00.000Z',
          retrievedAt: '2026-09-16T09:00:00.000Z',
          freshnessSeconds: 0,
          value: { last: 512.4 },
        },
      ],
      gaps: ['财务数据 Provider 尚未配置'],
    });

    expect(report.evidenceRefs).toEqual(['evidence_1']);
    expect(report.gaps).toEqual(['财务数据 Provider 尚未配置']);
    expect(report.stance).toBe('neutral');
    expect(report.risks.join(' ')).toContain('演示数据');
    expect(
      validateResearchReportEvidence(report, [
        {
          id: 'evidence_1',
          stepId: 'step_1',
          symbol: '0700.HK',
          metric: 'quote',
          sourceId: 'demo:quote:0700.HK',
          sourceKind: 'demo_fixture',
          asOf: '2026-09-16T09:00:00.000Z',
          retrievedAt: '2026-09-16T09:00:00.000Z',
          freshnessSeconds: 0,
          value: { last: 512.4 },
        },
      ]).valid,
    ).toBe(true);
    expect(validateResearchReportEvidence(report, []).missing).toEqual([
      'evidence_1',
    ]);
  });
});
