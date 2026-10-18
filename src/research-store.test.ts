import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import Database from './sqlite-compat.js';
import { createResearchPlan } from './research-model.js';
import {
  addResearchEvidence,
  bindResearchDatabase,
  claimResearchRun,
  commitResearchStepResult,
  createResearchRun,
  createResearchSchema,
  listResearchEvidence,
  listResearchSteps,
  startResearchStep,
} from './research-store.js';

let database: InstanceType<typeof Database> | undefined;
let tempDir: string | undefined;

function prepareRetry(runId: string, stepId: string): void {
  database!
    .prepare(
      `UPDATE research_runs SET status = 'queued', lease_owner = NULL,
     lease_expires_at = NULL, available_at = ? WHERE id = ?`,
    )
    .run(new Date().toISOString(), runId);
  database!
    .prepare(
      `UPDATE research_steps SET status = 'queued', lease_owner = NULL,
     lease_expires_at = NULL WHERE id = ?`,
    )
    .run(stepId);
}

afterEach(() => {
  database?.close();
  database = undefined;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('research evidence generations', () => {
  test('direct evidence writes are idempotent and keep one current generation', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-research-store-'));
    database = new Database(path.join(tempDir, 'research.db'));
    createResearchSchema(database);
    bindResearchDatabase(database);
    const run = createResearchRun({
      userId: 'user-1',
      symbol: '0700.HK',
      question: '重复证据',
      plan: createResearchPlan(),
    });
    const step = listResearchSteps(run.id)[0]!;
    const input = {
      runId: run.id,
      stepId: step.id,
      symbol: '0700.HK',
      metric: 'quote',
      sourceId: 'test:quote',
      sourceKind: 'test_provider',
      asOf: '2026-09-16T09:00:00.000Z',
      retrievedAt: '2026-09-16T09:00:01.000Z',
      value: { last: 500 },
      attempt: 1,
    };
    expect(addResearchEvidence(input)).toBe(addResearchEvidence(input));
    expect(listResearchEvidence(run.id)).toHaveLength(1);
  });

  test('failed retry keeps old current evidence, successful retry archives it', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-research-store-'));
    database = new Database(path.join(tempDir, 'research.db'));
    createResearchSchema(database);
    bindResearchDatabase(database);

    const run = createResearchRun({
      userId: 'user-1',
      symbol: '0700.HK',
      question: '证据保留',
      plan: createResearchPlan(),
    });
    const firstClaim = claimResearchRun(run.id, 'worker-1', 60_000)!;
    const step = listResearchSteps(run.id).find(
      (candidate) => candidate.capability === 'quote',
    )!;
    const firstStep = startResearchStep(
      run.id,
      step.id,
      firstClaim.leaseOwner,
      firstClaim.leaseToken,
      60_000,
    )!;
    const firstEvidence = {
      symbol: '0700.HK',
      metric: 'quote',
      sourceId: 'provider:quote:v1',
      sourceKind: 'test_provider',
      asOf: '2026-09-16T09:00:00.000Z',
      retrievedAt: '2026-09-16T09:00:01.000Z',
      retrievalLatencySeconds: 1,
      maxAgeSeconds: 3600,
      value: { last: 500 },
    };
    expect(
      commitResearchStepResult({
        runId: run.id,
        stepId: step.id,
        owner: firstClaim.leaseOwner,
        runToken: firstClaim.leaseToken,
        stepAttempt: firstStep.attempt,
        parameters: firstStep.parameters,
        status: 'completed',
        result: { ok: true },
        evidence: [firstEvidence],
      }),
    ).toBe(true);

    prepareRetry(run.id, step.id);
    const failedClaim = claimResearchRun(run.id, 'worker-2', 60_000)!;
    const failedStep = startResearchStep(
      run.id,
      step.id,
      failedClaim.leaseOwner,
      failedClaim.leaseToken,
      60_000,
    )!;
    expect(
      commitResearchStepResult({
        runId: run.id,
        stepId: step.id,
        owner: failedClaim.leaseOwner,
        runToken: failedClaim.leaseToken,
        stepAttempt: failedStep.attempt,
        parameters: failedStep.parameters,
        status: 'failed',
        result: {},
        evidence: [],
        errorCode: 'provider_timeout',
        errorKind: 'provider',
        errorMessage: 'provider timeout',
      }),
    ).toBe(true);
    expect(listResearchEvidence(run.id)).toHaveLength(1);
    expect(listResearchEvidence(run.id)[0]?.isCurrent).toBe(true);

    prepareRetry(run.id, step.id);
    const successClaim = claimResearchRun(run.id, 'worker-3', 60_000)!;
    const successStep = startResearchStep(
      run.id,
      step.id,
      successClaim.leaseOwner,
      successClaim.leaseToken,
      60_000,
    )!;
    expect(
      commitResearchStepResult({
        runId: run.id,
        stepId: step.id,
        owner: successClaim.leaseOwner,
        runToken: successClaim.leaseToken,
        stepAttempt: successStep.attempt,
        parameters: successStep.parameters,
        status: 'completed',
        result: { ok: true },
        evidence: [
          { ...firstEvidence, retrievedAt: '2026-09-16T09:01:00.000Z' },
        ],
      }),
    ).toBe(true);

    const history = listResearchEvidence(run.id, { includeHistory: true });
    expect(history).toHaveLength(2);
    expect(history.filter((item) => item.isCurrent)).toHaveLength(1);
    expect(listResearchEvidence(run.id)[0]?.retrievedAt).toBe(
      '2026-09-16T09:01:00.000Z',
    );
  });
});
