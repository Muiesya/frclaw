import type { ResearchEvidenceRef, ResearchReport } from './research-model.js';

export interface ResearchSynthesisInput {
  symbol: string;
  question: string;
  report: ResearchReport;
  evidence: ResearchEvidenceRef[];
  gaps: string[];
}

export interface ResearchSynthesisProvider {
  id: string;
  generate(input: {
    symbol: string;
    question: string;
    evidence: Array<{
      id: string;
      metric: string;
      sourceId: string;
      sourceKind: string;
      contentTrust?: string;
      promptInstructionsAllowed?: false;
      asOf: string | null;
      retrievedAt: string;
      value: unknown;
    }>;
    gaps: string[];
  }): Promise<unknown>;
}

export type ResearchSynthesisDraft = Pick<
  ResearchReport,
  | 'summary'
  | 'stance'
  | 'confidence'
  | 'bullArguments'
  | 'bearArguments'
  | 'catalysts'
  | 'risks'
  | 'gaps'
  | 'evidenceRefs'
>;

const STANCES = new Set<ResearchReport['stance']>([
  'bullish',
  'bearish',
  'neutral',
  'insufficient_data',
]);
const CONFIDENCES = new Set<ResearchReport['confidence']>([
  'high',
  'medium',
  'low',
]);

function stringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.length > 2_000)
  ) {
    throw new Error(`综合结果字段 ${field} 必须是字符串数组。`);
  }
  return value;
}

export function validateResearchSynthesisDraft(
  value: unknown,
  evidence: ResearchEvidenceRef[],
): ResearchSynthesisDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('综合结果必须是 JSON 对象。');
  }
  const draft = value as Record<string, unknown>;
  if (typeof draft.summary !== 'string' || draft.summary.length > 10_000) {
    throw new Error('综合结果缺少有效 summary。');
  }
  if (!STANCES.has(draft.stance as ResearchReport['stance'])) {
    throw new Error('综合结果包含无效 stance。');
  }
  if (!CONFIDENCES.has(draft.confidence as ResearchReport['confidence'])) {
    throw new Error('综合结果包含无效 confidence。');
  }
  if (
    !Array.isArray(draft.evidenceRefs) ||
    draft.evidenceRefs.some((item) => typeof item !== 'string')
  ) {
    throw new Error('综合结果缺少有效 evidenceRefs。');
  }
  const available = new Set(
    evidence.filter((item) => item.isCurrent !== false).map((item) => item.id),
  );
  const evidenceRefs = [...new Set(draft.evidenceRefs as string[])];
  const forged = evidenceRefs.filter((id) => !available.has(id));
  if (forged.length > 0) {
    throw new Error(
      `综合结果引用了不存在或非当前 EvidenceRef：${forged.join(', ')}`,
    );
  }
  return {
    summary: draft.summary,
    stance: draft.stance as ResearchReport['stance'],
    confidence: draft.confidence as ResearchReport['confidence'],
    bullArguments: stringArray(draft.bullArguments, 'bullArguments'),
    bearArguments: stringArray(draft.bearArguments, 'bearArguments'),
    catalysts: stringArray(draft.catalysts, 'catalysts'),
    risks: stringArray(draft.risks, 'risks'),
    gaps: stringArray(draft.gaps, 'gaps'),
    evidenceRefs,
  };
}

export async function synthesizeResearchReport(input: {
  baseReport: ResearchReport;
  evidence: ResearchEvidenceRef[];
  gaps: string[];
  provider?: ResearchSynthesisProvider;
}): Promise<ResearchReport> {
  if (!input.provider) {
    return {
      ...input.baseReport,
      synthesisStatus: 'synthesis_unavailable',
    };
  }
  try {
    const raw = await input.provider.generate({
      symbol: input.baseReport.symbol,
      question: input.baseReport.question,
      evidence: input.evidence
        .filter((item) => item.isCurrent !== false)
        .map((item) => ({
          id: item.id,
          metric: item.metric,
          sourceId: item.sourceId,
          sourceKind: item.sourceKind,
          contentTrust: item.contentTrust,
          promptInstructionsAllowed:
            item.contentTrust === 'untrusted_external' ? false : undefined,
          asOf: item.asOf,
          retrievedAt: item.retrievedAt,
          value: item.value,
        })),
      gaps: input.gaps,
    });
    const draft = validateResearchSynthesisDraft(raw, input.evidence);
    return {
      ...input.baseReport,
      ...draft,
      synthesisStatus: 'completed',
      synthesisProvider: input.provider.id,
    };
  } catch {
    return {
      ...input.baseReport,
      synthesisStatus: 'synthesis_unavailable',
    };
  }
}
