import { describe, expect, test } from 'vitest';

import {
  financeEvidenceConflictKey,
  normalizeFinanceResult,
  type FinanceEvidence,
} from '../src/finance/finance-evidence.js';

const now = Date.parse('2026-09-16T08:00:00.000Z');

const quoteEvidence: FinanceEvidence = {
  symbol: '0700',
  market: 'HK',
  entity: 'Tencent',
  asOf: '2026-09-16T07:59:00.000Z',
  retrievedAt: '2026-09-16T08:00:00.000Z',
  sourceId: 'longbridge:quote:0700:HK',
  sourceKind: 'longbridge',
  metric: 'last_price',
  value: 512.5,
  unit: 'HKD',
};

const freshness = { now: () => now, maxAgeMs: 5 * 60_000 };

describe('finance evidence normalization', () => {
  test('preserves complete evidence and provenance fields', () => {
    const result = normalizeFinanceResult(
      { status: 'complete', evidence: [quoteEvidence] },
      freshness,
    );

    expect(result).toMatchObject({
      status: 'complete',
      evidence: [quoteEvidence],
      missing: [],
      conflicts: [],
    });
  });

  test('rejects missing provenance instead of inventing it', () => {
    const { retrievedAt: _retrievedAt, ...withoutRetrievedAt } = quoteEvidence;

    const result = normalizeFinanceResult(
      { status: 'complete', evidence: [withoutRetrievedAt] },
      freshness,
    );

    expect(result.status).toBe('invalid');
    expect(result.missing).toContain('retrievedAt');
  });

  test('marks an old observation stale using the injected clock', () => {
    const result = normalizeFinanceResult(
      {
        status: 'complete',
        evidence: [
          {
            ...quoteEvidence,
            asOf: '2026-09-16T07:00:00.000Z',
          },
        ],
      },
      freshness,
    );

    expect(result.status).toBe('stale');
    expect(result.evidence).toHaveLength(1);
  });

  test('retains conflicting values from different sources', () => {
    const first = quoteEvidence;
    const second: FinanceEvidence = {
      ...quoteEvidence,
      sourceId: 'market-filing:quote:0700:HK',
      value: 510.25,
    };

    const result = normalizeFinanceResult(
      { status: 'complete', evidence: [first, second] },
      freshness,
    );

    expect(result.status).toBe('conflict');
    expect(result.evidence).toEqual([first, second]);
    expect(result.conflicts).toEqual([
      {
        key: financeEvidenceConflictKey(first),
        evidence: [first, second],
      },
    ]);
  });
});
