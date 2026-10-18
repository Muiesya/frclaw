import { createResearchNewsSnapshot } from './research-news-safety.js';
import type {
  ResearchCapability,
  ResearchCapabilityId,
  ResearchCapabilityResult,
} from './research-model.js';

interface ProviderEndpoint {
  id: string;
  url: string;
  apiKey?: string;
}

interface NormalizedProviderEvidence {
  symbol: string;
  market?: string;
  entity?: string;
  period?: string;
  metric: string;
  value: unknown;
  unit?: string;
  asOf: string | null;
  retrievedAt: string;
  sourceId: string;
  sourceKind: string;
  contentTrust?: 'licensed_provider' | 'untrusted_external';
  maxAgeSeconds?: number | null;
}

interface ProviderPayload {
  status?: ResearchCapabilityResult['status'];
  evidence?: NormalizedProviderEvidence[];
  missing?: string[];
  conflicts?: Array<{ key: string; evidence: unknown[] }>;
  error?: { code: string; message: string };
  recovery?: string;
}

function endpointsFor(capability: ResearchCapabilityId): ProviderEndpoint[] {
  const upper = capability.toUpperCase();
  const primary = process.env[`MINICLAW_${upper}_PROVIDER_URL`]?.trim();
  const fallback = process.env[`MINICLAW_${upper}_FALLBACK_URL`]?.trim();
  const key = process.env[`MINICLAW_${upper}_PROVIDER_KEY`]?.trim();
  const fallbackKey = process.env[`MINICLAW_${upper}_FALLBACK_KEY`]?.trim();
  return [
    ...(primary
      ? [{ id: `${capability}_primary`, url: primary, apiKey: key }]
      : []),
    ...(fallback
      ? [{ id: `${capability}_fallback`, url: fallback, apiKey: fallbackKey }]
      : []),
  ];
}

function allowedNewsHosts(): string[] {
  return (process.env.MINICLAW_RESEARCH_NEWS_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

function validateEndpoint(endpoint: ProviderEndpoint): void {
  const url = new URL(endpoint.url);
  if (url.protocol !== 'https:') {
    throw new Error('研究 Provider endpoint 必须使用 HTTPS。');
  }
}

function normalizePayload(
  capability: ResearchCapabilityId,
  payload: ProviderPayload,
  endpoint: ProviderEndpoint,
  retrievedAt: string,
): ResearchCapabilityResult {
  const rawEvidence = Array.isArray(payload.evidence) ? payload.evidence : [];
  const evidence = rawEvidence.map((item) => {
    if (
      !item.symbol ||
      !item.metric ||
      !item.sourceId ||
      !item.sourceKind ||
      !item.retrievedAt
    ) {
      throw new Error(`${endpoint.id} 返回的 Evidence 缺少来源或时间字段。`);
    }
    if (capability !== 'news') return item;
    const value =
      typeof item.value === 'object' && item.value !== null
        ? (item.value as Record<string, unknown>)
        : null;
    if (
      !value ||
      typeof value.url !== 'string' ||
      typeof value.title !== 'string' ||
      typeof value.content !== 'string'
    ) {
      throw new Error('新闻 Evidence 缺少 URL、标题或原文。');
    }
    const snapshot = createResearchNewsSnapshot(
      {
        sourceId: item.sourceId,
        sourceKind: item.sourceKind,
        url: value.url,
        title: value.title,
        content: value.content,
        publishedAt:
          typeof value.publishedAt === 'string' ? value.publishedAt : null,
        retrievedAt: item.retrievedAt || retrievedAt,
      },
      allowedNewsHosts(),
    );
    return {
      ...item,
      value: snapshot,
      sourceKind: snapshot.sourceKind,
      contentTrust: 'untrusted_external' as const,
    };
  });
  return {
    status: payload.status ?? (evidence.length > 0 ? 'complete' : 'partial'),
    evidence,
    missing: payload.missing ?? (evidence.length > 0 ? [] : [capability]),
    conflicts: payload.conflicts ?? [],
    ...(payload.error ? { error: payload.error } : {}),
    ...(payload.recovery ? { recovery: payload.recovery } : {}),
  };
}

async function callEndpoint(
  capability: ResearchCapabilityId,
  endpoint: ProviderEndpoint,
  input: { symbol: string; market: string },
  signal: AbortSignal,
): Promise<ResearchCapabilityResult> {
  validateEndpoint(endpoint);
  const url = new URL(endpoint.url);
  url.searchParams.set('symbol', input.symbol);
  url.searchParams.set('market', input.market);
  const response = await fetch(url, {
    signal,
    headers: endpoint.apiKey
      ? { authorization: `Bearer ${endpoint.apiKey}` }
      : undefined,
  });
  const retrievedAt = new Date().toISOString();
  if (response.status === 401 || response.status === 403) {
    return {
      status: 'provider_unavailable',
      evidence: [],
      missing: [capability],
      conflicts: [],
      error: {
        code: 'provider_auth_failed',
        message: `${endpoint.id} 认证失败。`,
      },
      recovery: '检查 Provider 凭据后重试。',
    };
  }
  if (response.status === 400) {
    return {
      status: 'invalid',
      evidence: [],
      missing: [capability],
      conflicts: [],
      error: {
        code: 'provider_invalid_request',
        message: `${endpoint.id} 拒绝了请求参数。`,
      },
    };
  }
  if (!response.ok) {
    return {
      status: 'failed',
      evidence: [],
      missing: [capability],
      conflicts: [],
      error: {
        code: 'provider_http_error',
        message: `${endpoint.id} 返回 HTTP ${response.status}。`,
      },
    };
  }
  const payload = (await response.json()) as ProviderPayload;
  return normalizePayload(capability, payload, endpoint, retrievedAt);
}

export interface ConfiguredResearchHttpCapability {
  capability: Exclude<ResearchCapabilityId, 'quote'>;
  providerIds: string[];
  capabilityAdapter: ResearchCapability;
}

export function createConfiguredResearchHttpCapabilities(): ConfiguredResearchHttpCapability[] {
  return (['fundamentals', 'valuation', 'news'] as const)
    .map((capability) => {
      const endpoints = endpointsFor(capability);
      if (endpoints.length === 0) return null;
      const adapter: ResearchCapability = {
        id: capability,
        provider: endpoints[0]!.id,
        async execute(input, signal) {
          let last: ResearchCapabilityResult | undefined;
          for (const endpoint of endpoints) {
            try {
              const result = await callEndpoint(
                capability,
                endpoint,
                input,
                signal,
              );
              last = result;
              if (
                result.status !== 'provider_unavailable' &&
                result.status !== 'failed'
              ) {
                return result;
              }
            } catch (error) {
              if (signal.aborted) throw error;
              last = {
                status: 'failed',
                evidence: [],
                missing: [capability],
                conflicts: [],
                error: {
                  code: 'provider_request_failed',
                  message:
                    error instanceof Error
                      ? error.message
                      : `${endpoint.id} 请求失败。`,
                },
              };
            }
          }
          return {
            ...(last ?? {
              status: 'provider_unavailable',
              evidence: [],
              missing: [capability],
              conflicts: [],
            }),
            recovery:
              endpoints.length > 1
                ? `主 Provider 和 ${endpoints.length - 1} 个备用 Provider 均不可用。`
                : '配置备用 Provider 后可重试。',
          };
        },
      };
      return {
        capability,
        providerIds: endpoints.map((endpoint) => endpoint.id),
        capabilityAdapter: adapter,
      };
    })
    .filter((item): item is ConfiguredResearchHttpCapability => item !== null);
}
