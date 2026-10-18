export const FINANCE_RESULT_STATUS = {
  complete: 'complete',
  partial: 'partial',
  stale: 'stale',
  conflict: 'conflict',
  providerUnavailable: 'provider_unavailable',
  invalid: 'invalid',
} as const satisfies Record<string, string>;

export type FinanceResultStatus =
  (typeof FINANCE_RESULT_STATUS)[keyof typeof FINANCE_RESULT_STATUS];

export interface FinanceEvidence {
  symbol: string;
  market: string;
  entity?: string;
  period?: string;
  metric?: string;
  asOf: string;
  retrievedAt: string;
  sourceId: string;
  sourceKind: string;
  value: unknown;
  unit?: string;
}

export interface FinanceEvidenceConflict {
  key: string;
  evidence: FinanceEvidence[];
}

export interface FinanceToolError {
  code: string;
  message: string;
}

export interface FinanceToolResult {
  status: FinanceResultStatus;
  evidence: FinanceEvidence[];
  missing: string[];
  conflicts: FinanceEvidenceConflict[];
  error?: FinanceToolError;
  recovery?: string;
}

export interface FinanceFreshnessPolicy {
  now: () => number;
  maxAgeMs: number;
}

const REQUIRED_EVIDENCE_FIELDS = [
  'symbol',
  'market',
  'asOf',
  'retrievedAt',
  'sourceId',
  'sourceKind',
  'value',
] as const;

type RequiredEvidenceField = (typeof REQUIRED_EVIDENCE_FIELDS)[number];

const DEFAULT_FRESHNESS: FinanceFreshnessPolicy = {
  now: () => Date.now(),
  maxAgeMs: 5 * 60_000,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isFinanceResultStatus(value: unknown): value is FinanceResultStatus {
  return (
    value === FINANCE_RESULT_STATUS.complete ||
    value === FINANCE_RESULT_STATUS.partial ||
    value === FINANCE_RESULT_STATUS.stale ||
    value === FINANCE_RESULT_STATUS.conflict ||
    value === FINANCE_RESULT_STATUS.providerUnavailable ||
    value === FINANCE_RESULT_STATUS.invalid
  );
}

function isFinanceEvidence(value: unknown): value is FinanceEvidence {
  if (!isRecord(value)) return false;
  if (
    !isNonEmptyString(value.symbol) ||
    !isNonEmptyString(value.market) ||
    !isTimestamp(value.asOf) ||
    !isTimestamp(value.retrievedAt) ||
    !isNonEmptyString(value.sourceId) ||
    !isNonEmptyString(value.sourceKind) ||
    !hasOwn(value, 'value')
  ) {
    return false;
  }

  for (const optionalField of ['entity', 'period', 'metric', 'unit']) {
    if (
      hasOwn(value, optionalField) &&
      value[optionalField] !== undefined &&
      !isNonEmptyString(value[optionalField])
    ) {
      return false;
    }
  }

  return true;
}

function collectMissingEvidenceFields(value: unknown): RequiredEvidenceField[] {
  if (!isRecord(value)) return ['symbol'];
  const missing: RequiredEvidenceField[] = [];
  if (!isNonEmptyString(value.symbol)) missing.push('symbol');
  if (!isNonEmptyString(value.market)) missing.push('market');
  if (!isTimestamp(value.asOf)) missing.push('asOf');
  if (!isTimestamp(value.retrievedAt)) missing.push('retrievedAt');
  if (!isNonEmptyString(value.sourceId)) missing.push('sourceId');
  if (!isNonEmptyString(value.sourceKind)) missing.push('sourceKind');
  if (!hasOwn(value, 'value')) missing.push('value');
  return missing;
}

function valueSignature(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function financeEvidenceConflictKey(
  evidence: Pick<FinanceEvidence, 'symbol' | 'market' | 'period' | 'metric'>,
): string {
  return JSON.stringify([
    evidence.symbol,
    evidence.market,
    evidence.period ?? null,
    evidence.metric ?? null,
  ]);
}

function findConflicts(evidence: FinanceEvidence[]): FinanceEvidenceConflict[] {
  const groups = new Map<string, FinanceEvidence[]>();
  for (const item of evidence) {
    const key = financeEvidenceConflictKey(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([key, group]) => ({ key, evidence: group }))
    .filter(({ evidence }) => {
      const sourceIds = new Set(evidence.map((item) => item.sourceId));
      const values = new Set(
        evidence.map((item) => valueSignature(item.value)),
      );
      return sourceIds.size > 1 && values.size > 1;
    });
}

function readSafeError(value: unknown): FinanceToolError | undefined {
  if (!isRecord(value)) return undefined;
  return isNonEmptyString(value.code) && isNonEmptyString(value.message)
    ? { code: value.code, message: value.message }
    : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isNonEmptyString) : [];
}

function invalidResult(missing: string[]): FinanceToolResult {
  return {
    status: FINANCE_RESULT_STATUS.invalid,
    evidence: [],
    missing: [...new Set(missing)],
    conflicts: [],
    recovery: '补充缺失的证券标识、时间和来源元数据后重试。',
  };
}

export function normalizeFinanceResult(
  input: unknown,
  freshness: FinanceFreshnessPolicy = DEFAULT_FRESHNESS,
): FinanceToolResult {
  if (!isRecord(input)) return invalidResult(['result']);

  const requestedStatus = input.status;
  const status = isFinanceResultStatus(requestedStatus)
    ? requestedStatus
    : undefined;
  const declaredMissing = new Set(readStringArray(input.missing));
  const contractMissing = new Set<string>();
  if (!status) contractMissing.add('status');
  if (!status) return invalidResult([...declaredMissing, ...contractMissing]);

  if (!Array.isArray(input.evidence)) {
    contractMissing.add('evidence');
    return invalidResult([...declaredMissing, ...contractMissing]);
  }

  const evidence: FinanceEvidence[] = [];
  for (const item of input.evidence) {
    if (isFinanceEvidence(item)) {
      evidence.push(item);
      continue;
    }
    for (const field of collectMissingEvidenceFields(item))
      contractMissing.add(field);
  }

  if (contractMissing.size > 0) {
    return invalidResult([...declaredMissing, ...contractMissing]);
  }

  const conflicts = findConflicts(evidence);
  let normalizedStatus: FinanceResultStatus = status;
  if (conflicts.length > 0) {
    normalizedStatus = FINANCE_RESULT_STATUS.conflict;
  } else if (
    status === FINANCE_RESULT_STATUS.complete &&
    evidence.some(
      (item) =>
        freshness.now() - Date.parse(item.asOf) >
        Math.max(0, freshness.maxAgeMs),
    )
  ) {
    normalizedStatus = FINANCE_RESULT_STATUS.stale;
  }

  const result: FinanceToolResult = {
    status: normalizedStatus,
    evidence,
    missing: [...declaredMissing],
    conflicts,
  };
  const error = readSafeError(input.error);
  if (error) result.error = error;
  if (isNonEmptyString(input.recovery)) result.recovery = input.recovery;
  return result;
}
