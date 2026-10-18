import { describe, expect, test } from 'vitest';
import {
  synthesizeResearchReport,
  validateResearchSynthesisDraft,
} from './research-synthesis.js';
import type { ResearchEvidenceRef, ResearchReport } from './research-model.js';

const evidence: ResearchEvidenceRef[] = [
  {
    id: 'evidence-1',
    stepId: 'step-1',
    symbol: '0700.HK',
    metric: 'quote',
    sourceId: 'longbridge:quote:0700.HK',
    sourceKind: 'longbridge_openapi',
    asOf: '2026-09-16T09:00:00.000Z',
    retrievedAt: '2026-09-16T09:00:01.000Z',
    value: { last: 512.4 },
    isCurrent: true,
  },
];

const baseReport: ResearchReport = {
  version: 1,
  generatedAt: '2026-09-16T09:00:01.000Z',
  status: 'partial',
  symbol: '0700.HK',
  question: '研究风险',
  summary: '确定性报告',
  stance: 'insufficient_data',
  confidence: 'low',
  bullArguments: [],
  bearArguments: [],
  catalysts: [],
  risks: [],
  gaps: ['fundamentals'],
  evidenceRefs: ['evidence-1'],
};

const draft = {
  summary: '仅基于已有证据的综合',
  stance: 'neutral',
  confidence: 'low',
  bullArguments: [],
  bearArguments: [],
  catalysts: [],
  risks: [],
  gaps: ['fundamentals'],
  evidenceRefs: ['evidence-1'],
};

describe('research synthesis evidence boundary', () => {
  test('rejects forged EvidenceRef IDs', () => {
    expect(() =>
      validateResearchSynthesisDraft(
        { ...draft, evidenceRefs: ['forged'] },
        evidence,
      ),
    ).toThrow('不存在');
  });

  test('keeps a deterministic report when the model provider is unavailable', async () => {
    const report = await synthesizeResearchReport({
      baseReport,
      evidence,
      gaps: baseReport.gaps,
    });
    expect(report.summary).toBe(baseReport.summary);
    expect(report.synthesisStatus).toBe('synthesis_unavailable');
  });

  test('accepts only a structured, evidence-referencing provider result', async () => {
    const report = await synthesizeResearchReport({
      baseReport,
      evidence,
      gaps: baseReport.gaps,
      provider: {
        id: 'test-model',
        async generate() {
          return draft;
        },
      },
    });
    expect(report.synthesisStatus).toBe('completed');
    expect(report.synthesisProvider).toBe('test-model');
    expect(report.evidenceRefs).toEqual(['evidence-1']);
  });
});
