import {
  validateResearchReportEvidence,
  type ResearchEvidenceRef,
  type ResearchReport,
  type ResearchRunStatus,
  type ResearchStepStatus,
} from './research-model.js';

export interface ResearchEvalSnapshot {
  status: ResearchRunStatus;
  steps: Array<{
    id: string;
    capability: string;
    provider: string;
    status: ResearchStepStatus;
    attempt: number;
  }>;
  evidence: ResearchEvidenceRef[];
  report: ResearchReport | null;
}

export interface ResearchEvalCheck {
  id: string;
  passed: boolean;
  details: string;
}

export interface ResearchEvalResult {
  passed: boolean;
  checks: ResearchEvalCheck[];
}

export interface ResearchGoldenCase {
  id: string;
  description: string;
  expectedStatus: ResearchRunStatus;
  expectedReportStatus: ResearchReport['status'];
}

/** Deterministic cases are intentionally small and provider-independent. */
export const RESEARCH_GOLDEN_CASES: ResearchGoldenCase[] = [
  {
    id: 'quote-plus-provider-gaps',
    description: '有效行情证据加未配置能力应为部分成功',
    expectedStatus: 'partial',
    expectedReportStatus: 'partial',
  },
  {
    id: 'no-evidence-provider-unavailable',
    description: '没有任何证据时不能把 Provider 缺口伪装成部分成功',
    expectedStatus: 'failed',
    expectedReportStatus: 'failed',
  },
  {
    id: 'cancelled-with-known-evidence',
    description: '取消运行保留已确认证据并明确报告状态',
    expectedStatus: 'cancelled',
    expectedReportStatus: 'cancelled',
  },
];

function check(
  id: string,
  passed: boolean,
  details: string,
): ResearchEvalCheck {
  return { id, passed, details };
}

export function evaluateResearchSnapshot(
  snapshot: ResearchEvalSnapshot,
): ResearchEvalResult {
  const checks: ResearchEvalCheck[] = [];
  const reportEvidence = snapshot.report
    ? validateResearchReportEvidence(snapshot.report, snapshot.evidence)
    : { valid: true, missing: [] };
  checks.push(
    check(
      'report-evidence-refs-exist',
      reportEvidence.valid,
      reportEvidence.valid
        ? '报告中的 EvidenceRef 全部存在于当前证据集合。'
        : `报告引用了不存在的 EvidenceRef：${reportEvidence.missing.join(', ')}`,
    ),
  );

  const unavailableStepIds = new Set(
    snapshot.steps
      .filter((step) => step.status === 'provider_unavailable')
      .map((step) => step.id),
  );
  const unavailableHasEvidence = snapshot.evidence.some((item) =>
    unavailableStepIds.has(item.stepId),
  );
  checks.push(
    check(
      'provider-unavailable-no-fake-evidence',
      !unavailableHasEvidence,
      unavailableHasEvidence
        ? 'Provider unavailable 步骤产生了 EvidenceRef。'
        : 'Provider unavailable 步骤没有产生虚假 EvidenceRef。',
    ),
  );

  const timestampsComplete = snapshot.evidence.every(
    (item) =>
      Number.isFinite(Date.parse(item.retrievedAt)) &&
      (item.asOf === null || Number.isFinite(Date.parse(item.asOf))),
  );
  checks.push(
    check(
      'evidence-source-time-complete',
      timestampsComplete,
      timestampsComplete
        ? '证据来源和取数时间可复核；缺失 asOf 保持为空。'
        : '证据包含不可解析的来源时间。',
    ),
  );

  const reportStatusMatchesRun =
    !snapshot.report ||
    (snapshot.status === 'completed' &&
      snapshot.report.status === 'complete') ||
    (snapshot.status === 'partial' && snapshot.report.status === 'partial') ||
    (snapshot.status === 'failed' && snapshot.report.status === 'failed') ||
    (snapshot.status === 'cancelled' &&
      snapshot.report.status === 'cancelled') ||
    [
      'planned',
      'queued',
      'running',
      'retry_wait',
      'uncertain',
      'manual_reconciliation',
    ].includes(snapshot.status);
  checks.push(
    check(
      'report-status-matches-run',
      reportStatusMatchesRun,
      reportStatusMatchesRun
        ? '报告状态与运行状态一致。'
        : '报告状态与运行状态不一致。',
    ),
  );

  const retryBudgetRespected = snapshot.steps.every(
    (step) => step.attempt <= 3,
  );
  checks.push(
    check(
      'retry-budget',
      retryBudgetRespected,
      retryBudgetRespected
        ? '所有步骤尝试次数在当前回归预算内。'
        : '步骤尝试次数超过回归预算 3 次。',
    ),
  );

  return { passed: checks.every((item) => item.passed), checks };
}

export function evaluateResearchGoldenCase(
  goldenCase: ResearchGoldenCase,
  snapshot: ResearchEvalSnapshot,
): ResearchEvalResult {
  const result = evaluateResearchSnapshot(snapshot);
  const expectedStatus = check(
    'golden-expected-status',
    snapshot.status === goldenCase.expectedStatus,
    `期望 ${goldenCase.expectedStatus}，实际 ${snapshot.status}。`,
  );
  const expectedReport = check(
    'golden-expected-report-status',
    snapshot.report?.status === goldenCase.expectedReportStatus,
    `期望报告 ${goldenCase.expectedReportStatus}，实际 ${snapshot.report?.status ?? 'none'}。`,
  );
  const checks = [...result.checks, expectedStatus, expectedReport];
  return { passed: checks.every((item) => item.passed), checks };
}
