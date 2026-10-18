import {
  createLongbridgeFinanceService,
  type LongbridgeCredentials,
  type LongbridgeFinanceService,
  type LongbridgeQuote,
} from './longbridge-service.js';

type FinanceResultStatus =
  | 'complete'
  | 'partial'
  | 'stale'
  | 'conflict'
  | 'provider_unavailable'
  | 'invalid';

interface FinanceEvidence {
  symbol: string;
  market: string;
  entity?: string;
  period?: string;
  metric?: string;
  asOf: string | null;
  retrievedAt: string;
  maxAgeSeconds?: number | null;
  sourceId: string;
  sourceKind: string;
  contentTrust?: 'licensed_provider' | 'demo_fixture';
  value: unknown;
  unit?: string;
}

export interface FinanceToolResult {
  status: FinanceResultStatus;
  evidence: FinanceEvidence[];
  missing: string[];
  conflicts: Array<{ key: string; evidence: FinanceEvidence[] }>;
  error?: { code: string; message: string };
  recovery?: string;
}

export interface FinanceSymbolQuery {
  symbol: string;
  market: string;
}

export interface FinancePositionsQuery {
  market?: string;
}

export interface FinanceHistoricalOrdersQuery {
  symbol?: string;
  market?: string;
  from?: string;
  to?: string;
  limit: number;
}

export interface LongbridgeReadOnlyCapability {
  getQuote(
    input: FinanceSymbolQuery,
    signal: AbortSignal,
  ): Promise<FinanceToolResult>;
  getSecurity(
    input: FinanceSymbolQuery,
    signal: AbortSignal,
  ): Promise<FinanceToolResult>;
  getPositions(
    input: FinancePositionsQuery,
    signal: AbortSignal,
  ): Promise<FinanceToolResult>;
  getHistoricalOrders(
    input: FinanceHistoricalOrdersQuery,
    signal: AbortSignal,
  ): Promise<FinanceToolResult>;
}

export interface LongbridgeReadOnlyCapabilityOptions {
  service?: LongbridgeFinanceService;
  credentials?: LongbridgeCredentials;
  demo?: boolean;
}

function unavailable(operation: string): FinanceToolResult {
  return {
    status: 'provider_unavailable',
    evidence: [],
    missing: [operation],
    conflicts: [],
    error: {
      code: 'unsupported_operation',
      message: `Longbridge ${operation} read-only capability is not available yet.`,
    },
    recovery: '当前工作台先支持行情查询；请改用 longbridge_get_quote。',
  };
}

function normalizeSymbol(input: FinanceSymbolQuery): string {
  const symbol = input.symbol.trim().toUpperCase();
  const market = input.market.trim().toUpperCase();
  return symbol.includes('.') ? symbol : `${symbol}.${market}`;
}

function quoteValue(quote: LongbridgeQuote): Record<string, unknown> {
  return {
    name: quote.name,
    last: quote.last,
    prevClose: quote.prevClose,
    change: quote.change,
    changePercent: quote.changePercent,
    open: quote.open,
    high: quote.high,
    low: quote.low,
    volume: quote.volume,
    turnover: quote.turnover,
    tradeStatus: quote.tradeStatus,
  };
}

function quoteEvidence(quote: LongbridgeQuote): FinanceEvidence {
  const asOf = quote.asOf;
  return {
    symbol: quote.symbol,
    market: quote.market,
    entity: quote.name,
    metric: 'quote',
    asOf,
    retrievedAt: quote.retrievedAt,
    sourceId: quote.sourceId,
    sourceKind:
      quote.source === 'longbridge' ? 'longbridge_openapi' : 'demo_fixture',
    contentTrust:
      quote.source === 'longbridge' ? 'licensed_provider' : 'demo_fixture',
    value: quoteValue(quote),
  };
}

function quoteResult(
  status: 'live' | 'demo' | 'provider_unavailable',
  quote: LongbridgeQuote | undefined,
  message: string | undefined,
): FinanceToolResult {
  if (status === 'provider_unavailable') {
    return {
      status: 'provider_unavailable',
      evidence: [],
      missing: ['quote'],
      conflicts: [],
      error: {
        code: 'provider_unavailable',
        message: message || 'Longbridge 数据暂不可用，请稍后重试。',
      },
      recovery: '配置 Longbridge 凭据并检查网络后重试。',
    };
  }

  if (!quote) {
    return {
      status: 'partial',
      evidence: [],
      missing: ['quote'],
      conflicts: [],
      recovery: '检查证券代码和市场代码后重试。',
    };
  }

  return {
    status:
      status === 'live' && quote.evidenceStatus === 'complete'
        ? 'complete'
        : 'partial',
    evidence: [quoteEvidence(quote)],
    missing: [
      ...(quote.last === null ? ['last'] : []),
      ...(quote.asOf === null ? ['asOf'] : []),
    ],
    conflicts: [],
    recovery:
      status === 'demo'
        ? '当前为演示数据；在金融研究页面配置 Longbridge 凭据后重试，以获取实时数据。'
        : undefined,
  };
}

export function createLongbridgeReadOnlyCapability(
  options: LongbridgeReadOnlyCapabilityOptions = {},
): LongbridgeReadOnlyCapability {
  const service = options.service ?? createLongbridgeFinanceService();

  return {
    async getQuote(input, signal) {
      if (signal.aborted) return unavailable('quote');
      const result = await service.getQuotes([normalizeSymbol(input)], {
        credentials: options.credentials,
        demo: options.demo,
      });
      return quoteResult(result.status, result.quotes[0], result.message);
    },
    async getSecurity(_input, _signal) {
      return unavailable('security');
    },
    async getPositions(_input, _signal) {
      return unavailable('positions');
    },
    async getHistoricalOrders(_input, _signal) {
      return unavailable('historical_orders');
    },
  };
}
