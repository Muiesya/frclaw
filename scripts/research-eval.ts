import {
  evaluateResearchGoldenCase,
  RESEARCH_GOLDEN_CASES,
  type ResearchEvalSnapshot,
} from '../src/research-eval.js';

const evidence = {
  id: 'eval-evidence-quote',
  stepId: 'eval-step-quote',
  symbol: '0700.HK',
  metric: 'quote',
  sourceId: 'fixture:quote',
  sourceKind: 'demo_fixture',
  asOf: '2026-09-16T09:00:00.000Z',
  retrievedAt: '2026-09-16T09:00:01.000Z',
  retrievalLatencySeconds: 1,
  ageSeconds: 1,
  maxAgeSeconds: 3600,
  isStale: false,
  value: { last: 512.4 },
};

function snapshotFor(id: string): ResearchEvalSnapshot {
  if (id === 'no-evidence-provider-unavailable') {
    return {
      status: 'failed',
      steps: [
        {
          id: 'eval-step-quote',
          capability: 'quote',
          provider: 'longbridge',
          status: 'provider_unavailable',
          attempt: 1,
        },
      ],
      evidence: [],
      report: {
        version: 1,
        generatedAt: new Date().toISOString(),
        status: 'failed',
        symbol: '0700.HK',
        question: 'eval',
        summary: 'failed',
        stance: 'insufficient_data',
        confidence: 'low',
        bullArguments: [],
        bearArguments: [],
        catalysts: [],
        risks: [],
        gaps: ['quote'],
        evidenceRefs: [],
      },
    };
  }
  if (id === 'cancelled-with-known-evidence') {
    return {
      status: 'cancelled',
      steps: [
        {
          id: 'eval-step-quote',
          capability: 'quote',
          provider: 'longbridge',
          status: 'completed',
          attempt: 1,
        },
      ],
      evidence: [evidence],
      report: {
        version: 1,
        generatedAt: new Date().toISOString(),
        status: 'cancelled',
        symbol: '0700.HK',
        question: 'eval',
        summary: 'cancelled',
        stance: 'neutral',
        confidence: 'low',
        bullArguments: [],
        bearArguments: [],
        catalysts: [],
        risks: [],
        gaps: [],
        evidenceRefs: [evidence.id],
      },
    };
  }
  return {
    status: 'partial',
    steps: [
      {
        id: 'eval-step-quote',
        capability: 'quote',
        provider: 'longbridge',
        status: 'completed',
        attempt: 1,
      },
      {
        id: 'eval-step-news',
        capability: 'news',
        provider: 'not_configured',
        status: 'provider_unavailable',
        attempt: 1,
      },
    ],
    evidence: [evidence],
    report: {
      version: 1,
      generatedAt: new Date().toISOString(),
      status: 'partial',
      symbol: '0700.HK',
      question: 'eval',
      summary: 'partial',
      stance: 'neutral',
      confidence: 'low',
      bullArguments: [],
      bearArguments: [],
      catalysts: [],
      risks: [],
      gaps: ['news'],
      evidenceRefs: [evidence.id],
    },
  };
}

let failed = false;
for (const goldenCase of RESEARCH_GOLDEN_CASES) {
  const result = evaluateResearchGoldenCase(
    goldenCase,
    snapshotFor(goldenCase.id),
  );
  console.log(
    JSON.stringify({
      caseId: goldenCase.id,
      passed: result.passed,
      checks: result.checks,
      providerMode: 'deterministic_fixture',
      liveIntegration: 'blocked_without_credentials',
    }),
  );
  if (!result.passed) failed = true;
}
process.exitCode = failed ? 1 : 0;
