import { Config, QuoteContext } from 'longbridge';

export interface LongbridgeCredentials {
  appKey: string;
  appSecret: string;
  accessToken: string;
}

/** The small subset of the SDK quote object needed by the web/API layer. */
export interface LongbridgeSdkQuote {
  symbol: unknown;
  lastDone: unknown;
  prevClose: unknown;
  open: unknown;
  high: unknown;
  low: unknown;
  timestamp: unknown;
  volume: unknown;
  turnover: unknown;
  tradeStatus: unknown;
}

export type LongbridgeConnectionMode = 'live' | 'demo';

export interface LongbridgeConnectionStatus {
  configured: boolean;
  mode: LongbridgeConnectionMode;
  source: 'longbridge' | 'demo';
  message: string;
  appKeyMasked: string | null;
}

export interface LongbridgeQuote {
  symbol: string;
  market: string;
  name: string;
  last: number | null;
  prevClose: number | null;
  change: number | null;
  changePercent: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  turnover: number | null;
  tradeStatus: string;
  asOf: string | null;
  retrievedAt: string;
  source: 'longbridge' | 'demo';
  evidenceStatus: 'complete' | 'partial' | 'demo';
  sourceId: string;
}

export interface LongbridgeQuoteResult {
  status: 'live' | 'demo' | 'provider_unavailable';
  source: 'longbridge' | 'demo';
  retrievedAt: string;
  quotes: LongbridgeQuote[];
  message?: string;
}

export interface LongbridgeServiceOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  fetchQuotes?: (
    credentials: LongbridgeCredentials,
    symbols: string[],
  ) => Promise<LongbridgeSdkQuote[]>;
}

export interface GetQuotesOptions {
  credentials?: LongbridgeCredentials;
  demo?: boolean;
}

const DEMO_QUOTE_SEED: Record<
  string,
  Omit<LongbridgeQuote, 'retrievedAt' | 'asOf' | 'sourceId'>
> = {
  '0700.HK': {
    symbol: '0700.HK',
    market: 'HK',
    name: '腾讯控股',
    last: 512.4,
    prevClose: 500,
    change: 12.4,
    changePercent: 2.48,
    open: 501,
    high: 514,
    low: 498.5,
    volume: 12345600,
    turnover: 6323456789,
    tradeStatus: '正常交易',
    source: 'demo',
    evidenceStatus: 'demo',
  },
  '9988.HK': {
    symbol: '9988.HK',
    market: 'HK',
    name: '阿里巴巴-SW',
    last: 142.8,
    prevClose: 145.2,
    change: -2.4,
    changePercent: -1.65,
    open: 144.1,
    high: 145.3,
    low: 141.7,
    volume: 8456700,
    turnover: 1213400000,
    tradeStatus: '正常交易',
    source: 'demo',
    evidenceStatus: 'demo',
  },
  'AAPL.US': {
    symbol: 'AAPL.US',
    market: 'US',
    name: 'Apple Inc.',
    last: 245.12,
    prevClose: 242.96,
    change: 2.16,
    changePercent: 0.89,
    open: 243.4,
    high: 246.05,
    low: 242.88,
    volume: 34890500,
    turnover: 8534000000,
    tradeStatus: '正常交易',
    source: 'demo',
    evidenceStatus: 'demo',
  },
  'TSLA.US': {
    symbol: 'TSLA.US',
    market: 'US',
    name: 'Tesla Inc.',
    last: 338.7,
    prevClose: 343.25,
    change: -4.55,
    changePercent: -1.33,
    open: 340.1,
    high: 348.88,
    low: 337.25,
    volume: 62164016,
    turnover: 21375312140,
    tradeStatus: '正常交易',
    source: 'demo',
    evidenceStatus: 'demo',
  },
};

function normalizeSymbols(symbols: string[]): string[] {
  const normalized = Array.from(
    new Set(
      symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean),
    ),
  );
  if (normalized.length === 0) throw new Error('至少输入一个证券代码');
  if (normalized.length > 500) {
    throw new Error('单次最多查询 500 个证券代码');
  }
  return normalized;
}

function readCredentials(env: NodeJS.ProcessEnv): LongbridgeCredentials | null {
  const appKey = env.LONGBRIDGE_APP_KEY?.trim() ?? '';
  const appSecret = env.LONGBRIDGE_APP_SECRET?.trim() ?? '';
  const accessToken = env.LONGBRIDGE_ACCESS_TOKEN?.trim() ?? '';
  if (!appKey || !appSecret || !accessToken) return null;
  return { appKey, appSecret, accessToken };
}

function maskAppKey(value: string): string {
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function asNumber(value: unknown): number | null {
  const parsed = Number(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function asIsoString(value: unknown): string | null {
  const date = value instanceof Date ? value : new Date(String(value ?? ''));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function asString(value: unknown, fallback: string): string {
  const result = String(value ?? '').trim();
  return result || fallback;
}

async function fetchLiveQuotes(
  credentials: LongbridgeCredentials,
  symbols: string[],
): Promise<LongbridgeSdkQuote[]> {
  const config = Config.fromApikey(
    credentials.appKey,
    credentials.appSecret,
    credentials.accessToken,
  );
  const context = QuoteContext.new(config);
  return (await context.quote(symbols)) as LongbridgeSdkQuote[];
}

function normalizeSdkQuote(
  quote: LongbridgeSdkQuote,
  retrievedAt: string,
): LongbridgeQuote {
  const symbol = asString(quote.symbol, 'UNKNOWN');
  const last = asNumber(quote.lastDone);
  const prevClose = asNumber(quote.prevClose);
  const change =
    last !== null && prevClose !== null
      ? Number((last - prevClose).toFixed(6))
      : null;
  const changePercent =
    change !== null && prevClose !== null && prevClose !== 0
      ? Number(((change / prevClose) * 100).toFixed(2))
      : null;
  const asOf = asIsoString(quote.timestamp);

  return {
    symbol,
    market: symbol.split('.').pop() || 'UNKNOWN',
    name: symbol,
    last,
    prevClose,
    change,
    changePercent,
    open: asNumber(quote.open),
    high: asNumber(quote.high),
    low: asNumber(quote.low),
    volume: asNumber(quote.volume),
    turnover: asNumber(quote.turnover),
    tradeStatus: asString(quote.tradeStatus, '未知'),
    asOf,
    retrievedAt,
    source: 'longbridge',
    evidenceStatus: last !== null && asOf ? 'complete' : 'partial',
    sourceId: `longbridge:quote:${symbol}`,
  };
}

function createDemoQuote(symbol: string, retrievedAt: string): LongbridgeQuote {
  const seed = DEMO_QUOTE_SEED[symbol];
  if (seed) {
    return {
      ...seed,
      asOf: retrievedAt,
      retrievedAt,
      sourceId: `demo:quote:${symbol}`,
    };
  }
  return {
    symbol,
    market: symbol.split('.').pop() || 'UNKNOWN',
    name: symbol,
    last: null,
    prevClose: null,
    change: null,
    changePercent: null,
    open: null,
    high: null,
    low: null,
    volume: null,
    turnover: null,
    tradeStatus: '演示数据未覆盖',
    asOf: retrievedAt,
    retrievedAt,
    source: 'demo',
    evidenceStatus: 'demo',
    sourceId: `demo:quote:${symbol}`,
  };
}

export function createLongbridgeFinanceService(
  options: LongbridgeServiceOptions = {},
) {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const fetcher = options.fetchQuotes ?? fetchLiveQuotes;

  return {
    getStatus(credentials?: LongbridgeCredentials): LongbridgeConnectionStatus {
      const resolved = credentials ?? readCredentials(env);
      if (!resolved) {
        return {
          configured: false,
          mode: 'demo',
          source: 'demo',
          message: '未配置 Longbridge 凭据；研究运行不会生成演示证据。',
          appKeyMasked: null,
        };
      }
      return {
        configured: true,
        mode: 'live',
        source: 'longbridge',
        message: 'Longbridge 只读行情已配置，可查询实时数据。',
        appKeyMasked: maskAppKey(resolved.appKey),
      };
    },

    async getQuotes(
      inputSymbols: string[],
      queryOptions: GetQuotesOptions = {},
    ): Promise<LongbridgeQuoteResult> {
      const symbols = normalizeSymbols(inputSymbols);
      const retrievedAt = new Date(now()).toISOString();
      if (queryOptions.demo) {
        return {
          status: 'demo',
          source: 'demo',
          retrievedAt,
          quotes: symbols.map((symbol) => createDemoQuote(symbol, retrievedAt)),
          message: '当前为演示数据，不代表真实行情。',
        };
      }

      const credentials = queryOptions.credentials ?? readCredentials(env);
      if (!credentials) {
        return {
          status: 'provider_unavailable',
          source: 'longbridge',
          retrievedAt,
          quotes: [],
          message:
            '未配置 Longbridge 凭据；请显式请求 demo 模式后查看演示数据。',
        };
      }

      try {
        const sdkQuotes = await fetcher(credentials, symbols);
        return {
          status: 'live',
          source: 'longbridge',
          retrievedAt,
          quotes: sdkQuotes.map((quote) =>
            normalizeSdkQuote(quote, retrievedAt),
          ),
          message: '数据来自 Longbridge OpenAPI。',
        };
      } catch {
        return {
          status: 'provider_unavailable',
          source: 'longbridge',
          retrievedAt,
          quotes: [],
          message: 'Longbridge 数据暂不可用，请检查连接配置后重试。',
        };
      }
    },
  };
}

export type LongbridgeFinanceService = ReturnType<
  typeof createLongbridgeFinanceService
>;

export { normalizeSymbols, readCredentials };
