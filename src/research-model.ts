export const RESEARCH_CAPABILITIES = [
  'quote',
  'fundamentals',
  'valuation',
  'news',
] as const;

export type ResearchCapabilityId = (typeof RESEARCH_CAPABILITIES)[number];

const RESEARCH_SCENARIO_CAPABILITIES = {
  full: RESEARCH_CAPABILITIES,
  quote: ['quote'],
  earnings: ['quote', 'fundamentals'],
  events: ['quote', 'news'],
} as const satisfies Record<string, readonly ResearchCapabilityId[]>;

export type ResearchScenario = keyof typeof RESEARCH_SCENARIO_CAPABILITIES;
export const RESEARCH_SCENARIOS = Object.keys(
  RESEARCH_SCENARIO_CAPABILITIES,
) as ResearchScenario[];

export type ResearchRunStatus =
  | 'planned'
  | 'queued'
  | 'running'
  | 'retry_wait'
  | 'uncertain'
  | 'manual_reconciliation'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled';

export type ResearchStepStatus =
  | 'planned'
  | 'queued'
  | 'running'
  | 'retry_wait'
  | 'uncertain'
  | 'manual_reconciliation'
  | 'completed'
  | 'partial'
  | 'provider_unavailable'
  | 'stale'
  | 'conflict'
  | 'invalid'
  | 'failed'
  | 'cancelled';

export interface ResearchPlanStep {
  capability: ResearchCapabilityId;
  label: string;
  provider: string;
  required: boolean;
  dependsOn?: ResearchCapabilityId[];
  timeoutMs?: number;
  maxAttempts?: number;
  parameters?: Record<string, unknown>;
}

export interface ResearchPlan {
  version: 1;
  generatedAt: string;
  scenario?: ResearchScenario;
  capabilities: ResearchPlanStep[];
  execution?: { maxConcurrency: number; budgetUnits: number };
}

export interface ResearchEvidenceRef {
  id: string;
  stepId: string;
  symbol: string;
  market?: string;
  entity?: string;
  period?: string;
  metric: string;
  sourceId: string;
  sourceKind: string;
  asOf: string | null;
  retrievedAt: string;
  /** Time spent between the provider's as-of timestamp and retrieval. */
  retrievalLatencySeconds?: number | null;
  /** Age of the data at read time. This is not retrieval latency. */
  ageSeconds?: number | null;
  maxAgeSeconds?: number | null;
  isStale?: boolean | null;
  /** @deprecated Kept for backwards-compatible persisted/API clients. */
  freshnessSeconds?: number | null;
  value: unknown;
  unit?: string;
  contentTrust?:
    | 'system'
    | 'licensed_provider'
    | 'untrusted_external'
    | 'demo_fixture';
  attempt?: number;
  fingerprint?: string;
  isCurrent?: boolean;
}

export interface ResearchCapabilityResult {
  status:
    | 'complete'
    | 'partial'
    | 'provider_unavailable'
    | 'stale'
    | 'conflict'
    | 'invalid'
    | 'failed';
  evidence: Array<{
    symbol: string;
    market?: string;
    entity?: string;
    period?: string;
    metric: string;
    sourceId: string;
    sourceKind: string;
    contentTrust?:
      | 'system'
      | 'licensed_provider'
      | 'untrusted_external'
      | 'demo_fixture';
    asOf: string | null;
    retrievedAt: string;
    maxAgeSeconds?: number | null;
    unit?: string;
    value: unknown;
  }>;
  missing: string[];
  conflicts: Array<{ key: string; evidence: unknown[] }>;
  error?: { code: string; message: string };
  recovery?: string;
}

/** Provider-neutral contract shared by planning and capability execution. */
export interface ResearchCapabilityInput {
  symbol: string;
  market: string;
  question: string;
  parameters: Record<string, unknown>;
}

export interface ResearchCapability {
  id: ResearchCapabilityId;
  provider: string;
  execute(
    input: ResearchCapabilityInput,
    signal: AbortSignal,
  ): Promise<ResearchCapabilityResult>;
}

export interface ResearchReport {
  version: 1;
  generatedAt: string;
  status: 'complete' | 'partial' | 'failed' | 'cancelled';
  symbol: string;
  question: string;
  summary: string;
  stance: 'bullish' | 'bearish' | 'neutral' | 'insufficient_data';
  confidence: 'high' | 'medium' | 'low';
  bullArguments: string[];
  bearArguments: string[];
  catalysts: string[];
  risks: string[];
  gaps: string[];
  evidenceRefs: string[];
  synthesisStatus?: 'deterministic' | 'completed' | 'synthesis_unavailable';
  synthesisProvider?: string;
}

const CAPABILITY_LABELS: Record<ResearchCapabilityId, string> = {
  quote: '行情快照',
  fundamentals: '财务数据',
  valuation: '估值数据',
  news: '新闻与公告',
};

function configuredProviderId(capability: ResearchCapabilityId): string {
  if (capability === 'quote') return 'longbridge';
  const env = typeof process !== 'undefined' ? process.env : undefined;
  return env?.[`MINICLAW_${capability.toUpperCase()}_PROVIDER_URL`]?.trim()
    ? `${capability}_primary`
    : 'not_configured';
}

export function normalizeResearchSymbol(
  symbol: string,
  market?: string,
): string {
  const normalized = symbol.trim().toUpperCase();
  if (!normalized) throw new Error('证券代码不能为空');
  if (normalized.includes('.')) return normalized;
  const normalizedMarket = (market ?? '').trim().toUpperCase();
  if (!normalizedMarket) throw new Error('未包含市场代码，例如 0700.HK');
  return `${normalized}.${normalizedMarket}`;
}

export function createResearchPlan(
  now = new Date().toISOString(),
  scenario: ResearchScenario = 'full',
): ResearchPlan {
  const capabilities = RESEARCH_SCENARIO_CAPABILITIES[scenario];
  return {
    version: 1,
    generatedAt: now,
    scenario,
    capabilities: capabilities.map((capability) => ({
      capability,
      label: CAPABILITY_LABELS[capability],
      provider: configuredProviderId(capability),
      required: scenario !== 'full' || capability === 'quote',
      timeoutMs: capability === 'quote' ? 15_000 : 10_000,
      maxAttempts: capability === 'quote' ? 2 : 1,
      parameters: {},
    })),
    execution: {
      maxConcurrency: Math.min(2, capabilities.length),
      budgetUnits: capabilities.length,
    },
  };
}

export function validateResearchReportEvidence(
  report: Pick<ResearchReport, 'evidenceRefs'>,
  evidence: ResearchEvidenceRef[],
): { valid: boolean; missing: string[] } {
  const current = evidence.filter((item) => item.isCurrent !== false);
  const available = new Set(current.map((item) => item.id));
  const missing = [...new Set(report.evidenceRefs)].filter(
    (id) => !available.has(id),
  );
  return {
    valid:
      missing.length === 0 &&
      report.evidenceRefs.length === new Set(report.evidenceRefs).size,
    missing,
  };
}

export function buildResearchReport(input: {
  symbol: string;
  question: string;
  generatedAt: string;
  status: 'complete' | 'partial' | 'failed' | 'cancelled';
  evidence: ResearchEvidenceRef[];
  gaps: string[];
}): ResearchReport {
  const quote = input.evidence.find((item) => item.metric === 'quote');
  const last =
    quote && typeof quote.value === 'object' && quote.value !== null
      ? (quote.value as { last?: unknown }).last
      : null;
  const numericLast = typeof last === 'number' ? last : null;
  const stance = numericLast === null ? 'insufficient_data' : 'neutral';
  const evidenceRefs = input.evidence.map((item) => item.id);

  return {
    version: 1,
    generatedAt: input.generatedAt,
    status: input.status,
    symbol: input.symbol,
    question: input.question,
    summary:
      input.status === 'complete'
        ? '研究所需数据已全部返回；请结合下方证据复核结论。'
        : input.status === 'cancelled'
          ? '研究在完成前被取消；以下仅包含取消前已确认的证据。'
          : input.status === 'failed'
            ? '研究未能获得可用的完整结果；不要将缺失数据视为零值。'
            : '研究已保留可用结果，但仍存在数据缺口；不要将缺失数据视为零值。',
    stance,
    confidence: numericLast === null ? 'low' : 'low',
    bullArguments:
      numericLast === null
        ? []
        : ['已获得带取数时间的行情快照，可作为后续研究起点。'],
    bearArguments:
      input.gaps.length > 0 ? ['部分所需数据未能取得，请查看数据缺口。'] : [],
    catalysts: [],
    risks: [
      '本报告仅供研究，不构成投资建议，也不执行交易。',
      ...(quote?.sourceKind === 'demo_fixture'
        ? ['行情为演示数据，不能用于真实投资判断。']
        : []),
    ],
    gaps: [...new Set(input.gaps)],
    evidenceRefs,
    synthesisStatus: 'deterministic',
  };
}

export const RESEARCH_MAX_AGE_SECONDS: Partial<
  Record<ResearchCapabilityId, number>
> = {
  quote: 24 * 60 * 60,
  fundamentals: 90 * 24 * 60 * 60,
  valuation: 7 * 24 * 60 * 60,
  news: 7 * 24 * 60 * 60,
};

function validTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function retrievalLatencySeconds(
  asOf: string | null,
  retrievedAt: string,
): number | null {
  const asOfMs = validTimestamp(asOf);
  const retrievedMs = validTimestamp(retrievedAt);
  if (asOfMs === null || retrievedMs === null) return null;
  return Math.max(0, Math.floor((retrievedMs - asOfMs) / 1000));
}

export function ageSeconds(
  asOf: string | null,
  nowMs = Date.now(),
): number | null {
  const asOfMs = validTimestamp(asOf);
  if (asOfMs === null || !Number.isFinite(nowMs)) return null;
  return Math.max(0, Math.floor((nowMs - asOfMs) / 1000));
}

export function isResearchEvidenceStale(
  asOf: string | null,
  maxAgeSeconds: number | null | undefined,
  nowMs = Date.now(),
): boolean | null {
  if (maxAgeSeconds === null || maxAgeSeconds === undefined) return null;
  const age = ageSeconds(asOf, nowMs);
  return age === null ? null : age > maxAgeSeconds;
}

/** @deprecated Use retrievalLatencySeconds; freshness was ambiguous. */
export function freshnessSeconds(
  asOf: string | null,
  retrievedAt: string,
): number | null {
  return retrievalLatencySeconds(asOf, retrievedAt);
}

export function deriveResearchRunStatus(input: {
  stepStatuses: ResearchStepStatus[];
  evidenceCount: number;
  cancelled?: boolean;
}): ResearchRunStatus {
  if (input.cancelled) return 'cancelled';
  if (
    input.stepStatuses.length > 0 &&
    input.stepStatuses.every((status) => status === 'completed')
  ) {
    return 'completed';
  }
  const hasUnrecoverableFailure = input.stepStatuses.some((status) =>
    ['failed', 'provider_unavailable'].includes(status),
  );
  // A run with no confirmed evidence is a failure, even when the reason is an
  // unconfigured provider. This prevents provider gaps from being presented as
  // a successful partial research result.
  if (hasUnrecoverableFailure && input.evidenceCount === 0) return 'failed';
  if (input.evidenceCount > 0) return 'partial';
  return 'failed';
}
