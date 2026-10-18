import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import Database from './sqlite-compat.js';
import { createResearchPlan } from './research-model.js';
import { createLongbridgeFinanceService } from './finance/longbridge-service.js';
import {
  bindResearchDatabase,
  createResearchRun,
  createResearchSchema,
  getResearchRun,
  listResearchEvidence,
} from './research-store.js';
import { executeResearchRun, getResearchRunView } from './research-service.js';

let database: InstanceType<typeof Database> | undefined;
let tempDir: string | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('Folio research execution', () => {
  test('does not create evidence when Providers are unavailable', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-research-'));
    database = new Database(path.join(tempDir, 'research.db'));
    createResearchSchema(database);
    bindResearchDatabase(database);

    const run = createResearchRun({
      userId: 'user-1',
      symbol: '0700.HK',
      question: '研究公开市场风险',
      plan: createResearchPlan('2026-09-16T09:00:00.000Z'),
    });

    await executeResearchRun(run.id);
    const view = getResearchRunView(run.id);
    expect(view?.status).toBe('failed');
    expect(view?.steps.map((step) => step.status)).toEqual([
      'provider_unavailable',
      'provider_unavailable',
      'provider_unavailable',
      'provider_unavailable',
    ]);
    expect(view?.evidence).toHaveLength(0);
    expect(view?.report?.evidenceRefs).toEqual([]);
    expect(view?.report?.gaps.length).toBe(4);
    expect(getResearchRun(run.id)?.report?.status).toBe('failed');
    const auditTypes = view?.audit.map((event) => event.eventType) ?? [];
    expect(auditTypes.slice(0, 3)).toEqual([
      'run_created',
      'run_queued',
      'run_claimed',
    ]);
    expect(
      auditTypes.filter((type) => type === 'capability_started'),
    ).toHaveLength(4);
    expect(
      auditTypes.filter((type) => type === 'provider_failed'),
    ).toHaveLength(4);
    expect(auditTypes.at(-1)).toBe('run_completed');

    // The finance page may still request an explicit demo fixture, but a
    // research run never treats that fixture as live evidence.
    expect(createLongbridgeFinanceService({ env: {} }).getStatus().source).toBe(
      'demo',
    );
    const demo = await createLongbridgeFinanceService({ env: {} }).getQuotes(
      ['0700.HK'],
      { demo: true },
    );
    expect(demo.status).toBe('demo');

    // A repeated execution/recovery attempt must not append an effective
    // EvidenceRef for an unavailable Provider.
    await executeResearchRun(run.id);
    expect(listResearchEvidence(run.id)).toHaveLength(0);
  });

  test('deduplicates a research request by user-scoped idempotency key', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-research-'));
    database = new Database(path.join(tempDir, 'research.db'));
    createResearchSchema(database);
    bindResearchDatabase(database);
    const input = {
      userId: 'user-1',
      symbol: '0700.HK',
      question: '同一个问题',
      plan: createResearchPlan(),
      idempotencyKey: 'request-1',
    };
    const first = createResearchRun(input);
    const second = createResearchRun(input);
    expect(second.id).toBe(first.id);
    expect(second.attempt).toBe(0);
  });
});
