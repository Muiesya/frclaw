import crypto from 'node:crypto';
import { logger } from './logger.js';
import {
  createResearchCapabilityRegistry,
  recordResearchProviderOutcome,
} from './research-provider-registry.js';
import {
  buildResearchReport,
  deriveResearchRunStatus,
  RESEARCH_MAX_AGE_SECONDS,
  retrievalLatencySeconds,
  validateResearchReportEvidence,
  type ResearchCapability,
  type ResearchCapabilityResult,
  type ResearchStepStatus,
} from './research-model.js';
import { synthesizeResearchReport } from './research-synthesis.js';
import { createConfiguredResearchSynthesisProvider } from './research-synthesis-http.js';
import {
  claimNextResearchRun,
  claimResearchRun,
  commitResearchStepResult,
  completeResearchRun,
  enqueueResearchRun,
  failResearchStep,
  getResearchRun,
  isResearchRunLeaseOwned,
  listResearchEvidence,
  listResearchSteps,
  markResearchRunUncertain,
  recoverResearchRunsOnStartup,
  listResearchAuditEvents,
  recordResearchAuditEvent,
  resetIncompleteResearchSteps,
  renewResearchRunLease,
  renewResearchStepLease,
  startResearchStep,
  updateResearchRun,
  type ClaimedResearchRun,
  type ResearchStep,
} from './research-store.js';

const RESEARCH_LEASE_MS = 60_000;
const RESEARCH_WORKER_POLL_MS = 500;
const activeControllers = new Map<string, AbortController>();
const activeRuns = new Map<string, Promise<void>>();
let workerTimer: ReturnType<typeof setTimeout> | null = null;
let workerRunning = false;
let workerStopping = false;
const workerOwner = `research-worker-${crypto.randomUUID()}`;

function timestamp(): string {
  return new Date().toISOString();
}

async function executeWithTimeout(
  capability: ResearchCapability,
  input: Parameters<ResearchCapability['execute']>[0],
  parentSignal: AbortSignal,
  timeoutMs: number,
): Promise<ResearchCapabilityResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parentSignal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const result = await capability.execute(input, controller.signal);
    if (parentSignal.aborted) {
      throw new Error('研究已取消或租约已失效。');
    }
    if (controller.signal.aborted) {
      throw new Error(`Provider 调用超过 ${timeoutMs} ms，结果未知。`);
    }
    return result;
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', abort);
  }
}

function resultRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : { value };
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isUnknownProviderError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /结果未知|超过 .* ms|aborted|timeout/i.test(error.message)
  );
}

function stepStatusFromCapability(status: string): ResearchStepStatus {
  if (status === 'complete') return 'completed';
  if (status === 'partial') return 'partial';
  if (status === 'provider_unavailable') return 'provider_unavailable';
  if (status === 'stale') return 'stale';
  if (status === 'conflict') return 'conflict';
  if (status === 'invalid') return 'invalid';
  return 'failed';
}

export function getResearchRunView(runId: string) {
  const run = getResearchRun(runId);
  if (!run) return undefined;
  const steps = listResearchSteps(runId);
  const providers = createResearchCapabilityRegistry(run.userId)
    .statuses()
    .map((provider) => {
      const providerSteps = steps.filter(
        (step) => step.provider === provider.id,
      );
      if (
        providerSteps.some((step) => step.status === 'provider_unavailable')
      ) {
        return { ...provider, health: 'unavailable' as const };
      }
      if (
        providerSteps.some((step) =>
          ['failed', 'uncertain', 'conflict', 'stale'].includes(step.status),
        )
      ) {
        return { ...provider, health: 'degraded' as const };
      }
      return provider;
    });
  return {
    ...run,
    steps,
    evidence: listResearchEvidence(runId),
    audit: listResearchAuditEvents(runId),
    providers,
  };
}

async function executeClaimedResearchRun(
  run: ClaimedResearchRun,
): Promise<void> {
  const controller = new AbortController();
  activeControllers.set(run.id, controller);
  recordResearchAuditEvent({
    runId: run.id,
    eventType: 'run_claimed',
    attempt: run.attempt,
    details: { owner: run.leaseOwner, leaseToken: run.leaseToken },
  });
  const heartbeat = setInterval(
    () => {
      // A lost lease fences all subsequent writes. Abort the provider promptly so
      // a stale worker cannot continue doing expensive work after takeover.
      if (!isResearchRunLeaseOwned(run.id, run.leaseOwner, run.leaseToken)) {
        controller.abort();
        return;
      }
      // The run and currently running step leases are renewed by the same
      // owner/token. This keeps a slow provider call from being taken over.
      renewResearchRunLease(
        run.id,
        run.leaseOwner,
        run.leaseToken,
        RESEARCH_LEASE_MS,
      );
      for (const step of listResearchSteps(run.id)) {
        if (step.status === 'running') {
          renewResearchStepLease(
            step.id,
            run.leaseOwner,
            run.leaseToken,
            RESEARCH_LEASE_MS,
          );
        }
      }
    },
    Math.floor(RESEARCH_LEASE_MS / 3),
  );

  try {
    const capabilities = createResearchCapabilityRegistry(run.userId);
    const steps = listResearchSteps(run.id);
    const executeStep = async (step: ResearchStep): Promise<void> => {
      if (controller.signal.aborted) {
        return;
      }
      const dependencies = listResearchSteps(run.id).filter((candidate) =>
        step.dependsOn.includes(candidate.capability),
      );
      if (
        dependencies.some(
          (dependency) =>
            ![
              'completed',
              'partial',
              'provider_unavailable',
              'stale',
              'conflict',
              'invalid',
              'failed',
              'cancelled',
            ].includes(dependency.status),
        )
      ) {
        await waitMs(25);
        return executeStep(step);
      }
      if (controller.signal.aborted) {
        if (step.status === 'running') {
          await failResearchStep({
            runId: run.id,
            stepId: step.id,
            owner: run.leaseOwner,
            runToken: run.leaseToken,
            stepAttempt: step.attempt,
            status: 'cancelled',
            errorCode: 'cancelled',
            errorKind: 'cancelled',
            errorMessage: '用户取消了研究运行，或研究租约已失效。',
          });
        }
        return;
      }
      if (
        step.status === 'completed' ||
        step.status === 'partial' ||
        step.status === 'provider_unavailable'
      ) {
        return;
      }
      if (!isResearchRunLeaseOwned(run.id, run.leaseOwner, run.leaseToken)) {
        controller.abort();
        return;
      }

      const claim = startResearchStep(
        run.id,
        step.id,
        run.leaseOwner,
        run.leaseToken,
        RESEARCH_LEASE_MS,
      );
      if (!claim) return;
      recordResearchAuditEvent({
        runId: run.id,
        eventType: 'capability_started',
        attempt: claim.attempt,
        details: {
          stepId: step.id,
          capability: step.capability,
          provider: step.provider,
        },
      });

      try {
        const capability = capabilities.get(step.capability, step.provider);
        const result = await executeWithTimeout(
          capability,
          {
            symbol: run.symbol,
            market: run.symbol.split('.')[1] ?? '',
            question: run.question,
            parameters: claim.parameters,
          },
          controller.signal,
          step.timeoutMs,
        );
        const mappedStatus = stepStatusFromCapability(result.status);
        recordResearchProviderOutcome(
          step.provider,
          result.status === 'complete' || result.status === 'partial'
            ? 'success'
            : 'failure',
        );
        const committed = commitResearchStepResult({
          runId: run.id,
          stepId: step.id,
          owner: run.leaseOwner,
          runToken: run.leaseToken,
          stepAttempt: claim.attempt,
          parameters: claim.parameters,
          status: mappedStatus,
          result: resultRecord(result),
          evidence: result.evidence.map((evidence) => ({
            symbol: evidence.symbol,
            market: evidence.market,
            entity: evidence.entity,
            period: evidence.period,
            metric: evidence.metric,
            sourceId: evidence.sourceId,
            sourceKind: evidence.sourceKind,
            contentTrust: evidence.contentTrust,
            asOf: evidence.asOf ?? null,
            retrievedAt: evidence.retrievedAt,
            retrievalLatencySeconds: retrievalLatencySeconds(
              evidence.asOf ?? null,
              evidence.retrievedAt,
            ),
            maxAgeSeconds:
              evidence.maxAgeSeconds ??
              RESEARCH_MAX_AGE_SECONDS[step.capability] ??
              null,
            unit: evidence.unit,
            value: evidence.value,
          })),
          errorCode: result.error?.code ?? null,
          errorKind:
            result.status === 'provider_unavailable'
              ? 'provider_unavailable'
              : result.status === 'stale'
                ? 'stale'
                : result.status === 'conflict'
                  ? 'conflict'
                  : result.status === 'invalid'
                    ? 'invalid'
                    : result.error
                      ? 'provider'
                      : null,
          errorMessage: result.error?.message ?? result.recovery ?? null,
        });
        recordResearchAuditEvent({
          runId: run.id,
          eventType: !committed
            ? 'capability_commit_rejected'
            : result.status === 'provider_unavailable' || result.error
              ? 'provider_failed'
              : 'capability_completed',
          attempt: claim.attempt,
          details: {
            stepId: step.id,
            capability: step.capability,
            provider: step.provider,
            status: result.status,
            evidenceCount: result.evidence.length,
            error: result.error?.message ?? null,
          },
        });
        if (!committed) controller.abort();
      } catch (error) {
        const cancelled = controller.signal.aborted;
        const unknown = !cancelled && isUnknownProviderError(error);
        const errorMessage = cancelled
          ? '用户取消了研究运行，或研究租约已失效。'
          : error instanceof Error
            ? error.message
            : '研究能力执行失败。';
        const retryable =
          !cancelled && !unknown && claim.attempt < step.maxAttempts;
        if (!cancelled) recordResearchProviderOutcome(step.provider, 'failure');
        await failResearchStep({
          runId: run.id,
          stepId: step.id,
          owner: run.leaseOwner,
          runToken: run.leaseToken,
          stepAttempt: claim.attempt,
          status: cancelled
            ? 'cancelled'
            : unknown
              ? 'uncertain'
              : retryable
                ? 'retry_wait'
                : 'failed',
          errorCode: cancelled
            ? 'cancelled'
            : unknown
              ? 'provider_timeout'
              : 'execution_failed',
          errorKind: cancelled
            ? 'cancelled'
            : unknown
              ? 'unknown'
              : 'execution',
          errorMessage,
        });
        recordResearchAuditEvent({
          runId: run.id,
          eventType: cancelled
            ? 'run_cancelled'
            : unknown
              ? 'provider_result_uncertain'
              : retryable
                ? 'capability_retry_wait'
                : 'provider_failed',
          attempt: claim.attempt,
          details: {
            stepId: step.id,
            capability: step.capability,
            provider: step.provider,
            reason: errorMessage,
            retryable,
          },
        });
        if (retryable && !controller.signal.aborted) {
          await waitMs(Math.min(1000, 100 * 2 ** (claim.attempt - 1)));
          await executeStep(step);
        }
      }
    };

    // Independent capability calls run through a small worker pool. The plan
    // remains persisted and replayable; concurrency is an execution limit, not
    // an additional agent runtime.
    const maxConcurrency = Math.max(
      1,
      Math.min(run.plan.execution?.maxConcurrency ?? 2, steps.length || 1),
    );
    let nextStep = 0;
    const workers = Array.from({ length: maxConcurrency }, async () => {
      while (!controller.signal.aborted) {
        const index = nextStep++;
        const step = steps[index];
        if (!step) return;
        await executeStep(step);
      }
    });
    await Promise.all(workers);

    if (!isResearchRunLeaseOwned(run.id, run.leaseOwner, run.leaseToken)) {
      return;
    }
    const finalSteps = listResearchSteps(run.id);
    const unresolved = finalSteps.find((step) =>
      ['uncertain', 'manual_reconciliation', 'retry_wait'].includes(
        step.status,
      ),
    );
    if (unresolved) {
      const unresolvedStatus: 'uncertain' | 'manual_reconciliation' =
        unresolved.status === 'manual_reconciliation'
          ? 'manual_reconciliation'
          : 'uncertain';
      markResearchRunUncertain(
        run.id,
        run.leaseOwner,
        run.leaseToken,
        unresolvedStatus,
      );
      recordResearchAuditEvent({
        runId: run.id,
        eventType: 'run_needs_reconciliation',
        details: {
          capability: unresolved.capability,
          status: unresolved.status,
          message: unresolved.errorMessage,
        },
      });
      return;
    }
    const evidence = listResearchEvidence(run.id);
    const gaps = finalSteps
      .filter((step) => step.status !== 'completed')
      .map(
        (step) =>
          step.errorMessage ?? `${step.capability} 能力未返回可复核结果。`,
      );
    const cancelled =
      controller.signal.aborted ||
      finalSteps.some((step) => step.status === 'cancelled');
    const status = deriveResearchRunStatus({
      stepStatuses: finalSteps.map((step) => step.status),
      evidenceCount: evidence.length,
      cancelled,
    });
    const deterministicReport = buildResearchReport({
      symbol: run.symbol,
      question: run.question,
      generatedAt: timestamp(),
      status:
        status === 'completed'
          ? 'complete'
          : status === 'partial'
            ? 'partial'
            : status === 'cancelled'
              ? 'cancelled'
              : 'failed',
      evidence,
      gaps,
    });
    const report = await synthesizeResearchReport({
      baseReport: deterministicReport,
      evidence,
      gaps,
      provider: createConfiguredResearchSynthesisProvider(),
    });
    const reportEvidence = validateResearchReportEvidence(report, evidence);
    completeResearchRun(
      run.id,
      run.leaseOwner,
      run.leaseToken,
      reportEvidence.valid ? status : 'failed',
      reportEvidence.valid
        ? report
        : buildResearchReport({
            symbol: run.symbol,
            question: run.question,
            generatedAt: timestamp(),
            status: 'failed',
            evidence,
            gaps: [
              ...gaps,
              ...reportEvidence.missing.map((id) => `报告引用缺失：${id}`),
            ],
          }),
    );
    recordResearchAuditEvent({
      runId: run.id,
      eventType:
        (reportEvidence.valid ? status : 'failed') === 'cancelled'
          ? 'run_cancelled'
          : 'run_completed',
      attempt: run.attempt,
      details: {
        status: reportEvidence.valid ? status : 'failed',
        evidenceCount: evidence.length,
      },
    });
  } catch (error) {
    if (isResearchRunLeaseOwned(run.id, run.leaseOwner, run.leaseToken)) {
      const message =
        error instanceof Error ? error.message : '研究运行未能完成。';
      completeResearchRun(
        run.id,
        run.leaseOwner,
        run.leaseToken,
        'failed',
        buildResearchReport({
          symbol: run.symbol,
          question: run.question,
          generatedAt: timestamp(),
          status: 'failed',
          evidence: listResearchEvidence(run.id),
          gaps: [message],
        }),
      );
    }
  } finally {
    clearInterval(heartbeat);
    activeControllers.delete(run.id);
  }
}

export async function executeResearchRun(runId: string): Promise<void> {
  if (activeControllers.has(runId)) return;
  const run = getResearchRun(runId);
  if (!run) return;
  enqueueResearchRun(runId);
  const claimed = claimResearchRun(
    runId,
    `research-direct-${crypto.randomUUID()}`,
    RESEARCH_LEASE_MS,
  );
  if (claimed) await trackResearchRun(claimed);
}

export function isResearchRunActive(runId: string): boolean {
  return activeControllers.has(runId);
}

export function cancelResearchRun(runId: string): boolean {
  const controller = activeControllers.get(runId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function resumeResearchRun(runId: string): void {
  resetIncompleteResearchSteps(runId);
  updateResearchRun(runId, {
    status: 'queued',
    report: null,
    completedAt: null,
  });
  enqueueResearchRun(runId);
  recordResearchAuditEvent({
    runId,
    eventType: 'run_recovered',
    details: { reason: 'manual_resume' },
  });
}

function trackResearchRun(run: ClaimedResearchRun): Promise<void> {
  const promise = executeClaimedResearchRun(run);
  activeRuns.set(run.id, promise);
  void promise.then(
    () => activeRuns.delete(run.id),
    () => activeRuns.delete(run.id),
  );
  return promise;
}

function pumpResearchWorker(): void {
  if (workerRunning || workerStopping) return;
  workerRunning = true;
  try {
    for (let count = 0; count < 2; count++) {
      const claimed = claimNextResearchRun(workerOwner, RESEARCH_LEASE_MS);
      if (!claimed) break;
      void trackResearchRun(claimed).catch((error) => {
        logger.error({ err: error }, 'Research worker execution failed');
      });
    }
  } finally {
    workerRunning = false;
    if (!workerStopping) {
      workerTimer = setTimeout(pumpResearchWorker, RESEARCH_WORKER_POLL_MS);
      workerTimer.unref?.();
    }
  }
}

export function startResearchWorker(): void {
  if (workerTimer || workerRunning) return;
  workerStopping = false;
  const recovered = recoverResearchRunsOnStartup();
  if (recovered > 0) {
    logger.info({ recovered }, 'Recovered interrupted research runs');
  }
  pumpResearchWorker();
}

export async function stopResearchWorker(): Promise<void> {
  workerStopping = true;
  if (workerTimer) {
    clearTimeout(workerTimer);
    workerTimer = null;
  }
  for (const controller of activeControllers.values()) controller.abort();
  await Promise.allSettled([...activeRuns.values()]);
}

export function researchWorkerIsRunning(): boolean {
  return Boolean(workerTimer || workerRunning);
}
