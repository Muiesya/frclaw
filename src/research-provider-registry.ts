import { getLongbridgeCredentialsForUser } from './finance/longbridge-session.js';
import { createLongbridgeReadOnlyCapability } from './finance/longbridge-agent-capability.js';
import type {
  ResearchCapability,
  ResearchCapabilityId,
  ResearchCapabilityResult,
} from './research-model.js';
import { createConfiguredResearchHttpCapabilities } from './research-http-providers.js';

export type ResearchProviderHealth =
  | 'healthy'
  | 'degraded'
  | 'unavailable'
  | 'unknown';

export interface ResearchProviderStatus {
  id: string;
  health: ResearchProviderHealth;
  capabilities: ResearchCapabilityId[];
  message: string;
  checkedAt: string;
  failureCount: number;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
}

export interface ResearchCapabilityRegistry {
  get(capability: ResearchCapabilityId, provider: string): ResearchCapability;
  statuses(): ResearchProviderStatus[];
}

const providerOutcomes = new Map<
  string,
  {
    failureCount: number;
    lastFailureAt: string | null;
    lastSuccessAt: string | null;
  }
>();

export function recordResearchProviderOutcome(
  provider: string,
  outcome: 'success' | 'failure',
): void {
  const previous = providerOutcomes.get(provider) ?? {
    failureCount: 0,
    lastFailureAt: null,
    lastSuccessAt: null,
  };
  const at = new Date().toISOString();
  providerOutcomes.set(provider, {
    failureCount:
      outcome === 'failure' ? previous.failureCount + 1 : previous.failureCount,
    lastFailureAt: outcome === 'failure' ? at : previous.lastFailureAt,
    lastSuccessAt: outcome === 'success' ? at : previous.lastSuccessAt,
  });
}

function outcomeStatus(provider: string) {
  return (
    providerOutcomes.get(provider) ?? {
      failureCount: 0,
      lastFailureAt: null,
      lastSuccessAt: null,
    }
  );
}

function unavailableCapability(
  id: ResearchCapabilityId,
  provider = 'not_configured',
): ResearchCapability {
  return {
    id,
    provider,
    async execute() {
      return {
        status: 'provider_unavailable',
        evidence: [],
        missing: [id],
        conflicts: [],
        error: {
          code: 'provider_unavailable',
          message: `${id} 能力尚未配置 Provider；已记录研究缺口，未用占位数据填充。`,
        },
        recovery: '配置真实 Provider 后恢复该研究运行。',
      } satisfies ResearchCapabilityResult;
    },
  };
}

function createQuoteCapability(userId: string): ResearchCapability {
  return {
    id: 'quote',
    provider: 'longbridge',
    async execute(input, signal) {
      const result = await createLongbridgeReadOnlyCapability({
        credentials: getLongbridgeCredentialsForUser(userId),
      }).getQuote(
        {
          symbol: input.symbol.split('.')[0] ?? input.symbol,
          market: input.symbol.split('.')[1] ?? '',
        },
        signal,
      );
      return {
        status: result.status === 'invalid' ? 'invalid' : result.status,
        evidence: result.evidence.map((evidence) => ({
          symbol: evidence.symbol,
          market: evidence.market,
          entity: evidence.entity,
          period: evidence.period,
          metric: evidence.metric ?? 'quote',
          unit: evidence.unit,
          sourceId: evidence.sourceId,
          sourceKind: evidence.sourceKind,
          contentTrust: evidence.contentTrust,
          asOf: evidence.asOf ?? null,
          retrievedAt: evidence.retrievedAt,
          value: evidence.value,
          ...(evidence.maxAgeSeconds !== undefined
            ? { maxAgeSeconds: evidence.maxAgeSeconds }
            : {}),
        })),
        missing: result.missing,
        conflicts: result.conflicts,
        ...(result.error ? { error: result.error } : {}),
        ...(result.recovery ? { recovery: result.recovery } : {}),
      };
    },
  };
}

/**
 * Provider-neutral routing boundary. Adding a data source should add an
 * adapter here, not a branch in the research executor or the Web page.
 */
export function createResearchCapabilityRegistry(
  userId: string,
): ResearchCapabilityRegistry {
  const quote = createQuoteCapability(userId);
  const configured = createConfiguredResearchHttpCapabilities();
  const configuredByCapability = new Map(
    configured.map((item) => [item.capability, item]),
  );
  const unavailable = new Map<ResearchCapabilityId, ResearchCapability>([
    ['fundamentals', unavailableCapability('fundamentals')],
    ['valuation', unavailableCapability('valuation')],
    ['news', unavailableCapability('news')],
  ]);
  const checkedAt = new Date().toISOString();

  return {
    get(capability, provider) {
      if (capability === 'quote' && provider === 'longbridge') return quote;
      const configuredProvider =
        capability === 'quote'
          ? undefined
          : configuredByCapability.get(capability);
      if (configuredProvider) return configuredProvider.capabilityAdapter;
      return (
        unavailable.get(capability) ??
        unavailableCapability(capability, provider)
      );
    },
    statuses() {
      const longbridgeOutcome = outcomeStatus('longbridge');
      const missingOutcome = outcomeStatus('not_configured');
      const statuses: ResearchProviderStatus[] = [
        {
          id: 'longbridge',
          health: getLongbridgeCredentialsForUser(userId)
            ? longbridgeOutcome.failureCount > 0
              ? ('degraded' as const)
              : ('healthy' as const)
            : ('unavailable' as const),
          capabilities: ['quote'],
          message: getLongbridgeCredentialsForUser(userId)
            ? 'Longbridge 只读行情已配置。'
            : '未配置凭据；不会生成演示 EvidenceRef。',
          checkedAt,
          ...longbridgeOutcome,
        },
        {
          id: 'not_configured',
          health: 'unavailable' as const,
          capabilities: ['fundamentals', 'valuation', 'news'],
          message: '财务、估值、新闻 Provider 尚未配置。',
          checkedAt,
          ...missingOutcome,
        },
      ];
      for (const item of configured) {
        const outcome = outcomeStatus(item.providerIds[0] ?? item.capability);
        statuses.push({
          id: item.providerIds[0] ?? item.capability,
          health: outcome.failureCount > 0 ? 'degraded' : 'healthy',
          capabilities: [item.capability],
          message:
            item.providerIds.length > 1
              ? `已配置主 Provider，并有 ${item.providerIds.length - 1} 个备用 Provider。`
              : '已配置 Provider。',
          checkedAt,
          ...outcome,
        });
      }
      return statuses;
    },
  };
}
