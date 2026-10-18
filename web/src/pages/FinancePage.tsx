import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Database,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  WifiOff,
} from 'lucide-react';

import { api } from '../api/client';
import { PageHeader } from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type ConnectionMode = 'live' | 'demo';

interface ConnectionState {
  configured: boolean;
  mode: ConnectionMode;
  source: 'longbridge' | 'demo';
  message: string;
  appKeyMasked: string | null;
}

interface FinanceStatusResponse {
  connection: ConnectionState;
  capabilities: string[];
  tradingEnabled: boolean;
}

interface FinanceQuote {
  symbol: string;
  market: string;
  name: string;
  last: number | null;
  prevClose: number | null;
  change: number | null;
  changePercent: number | null;
  volume: number | null;
  turnover: number | null;
  tradeStatus: string;
  asOf: string | null;
  retrievedAt: string;
  source: 'longbridge' | 'demo';
  evidenceStatus: 'complete' | 'partial' | 'demo';
  sourceId: string;
}

interface FinanceQuotesResponse {
  status: 'live' | 'demo' | 'provider_unavailable';
  source: 'longbridge' | 'demo';
  retrievedAt: string;
  quotes: FinanceQuote[];
  message?: string;
}

interface ConnectionDraft {
  appKey: string;
  appSecret: string;
  accessToken: string;
}

const DEFAULT_SYMBOLS = '0700.HK,9988.HK,AAPL.US,TSLA.US';
const CAPABILITY_LABELS: Record<string, string> = {
  quote: '实时行情',
  security: '证券资料',
  positions: '持仓查询',
  historical_orders: '历史订单',
};

function getErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return '请求失败，请检查后端服务。';
}

function formatPrice(value: number | null): string {
  if (value === null) return '—';
  return new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
}

function formatCompact(value: number | null): string {
  if (value === null) return '—';
  return new Intl.NumberFormat('zh-CN', {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(value);
}

function formatTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function marketLabel(market: string): string {
  if (market === 'HK') return '港股';
  if (market === 'US') return '美股';
  if (market === 'SH' || market === 'SZ') return 'A 股';
  return market;
}

function connectionLabel(connection: ConnectionState | null): string {
  if (!connection) return '检查中';
  if (connection.configured) return '已连接';
  return '未连接';
}

export function FinancePage() {
  const [connection, setConnection] = useState<ConnectionState | null>(null);
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [quotes, setQuotes] = useState<FinanceQuote[]>([]);
  const [quoteStatus, setQuoteStatus] =
    useState<FinanceQuotesResponse['status']>('demo');
  const [quoteMessage, setQuoteMessage] = useState('');
  const [symbols, setSymbols] = useState(DEFAULT_SYMBOLS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ConnectionDraft>({
    appKey: '',
    appSecret: '',
    accessToken: '',
  });

  const loadQuotes = async (query: string, demo: boolean) => {
    const encoded = encodeURIComponent(query);
    const result = await api.get<FinanceQuotesResponse>(
      `/api/finance/longbridge/quotes?symbols=${encoded}${demo ? '&demo=1' : ''}`,
    );
    setQuotes(result.quotes);
    setQuoteStatus(result.status);
    setQuoteMessage(result.message ?? '');
  };

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.get<FinanceStatusResponse>(
        '/api/finance/longbridge/status',
      );
      setConnection(result.connection);
      setCapabilities(result.capabilities);
      await loadQuotes(symbols, !result.connection.configured);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const handleQuery = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!symbols.trim()) {
      setError('请输入至少一个证券代码，例如 0700.HK 或 AAPL.US。');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await loadQuotes(symbols, false);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleConnect = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const result = await api.put<FinanceStatusResponse>(
        '/api/finance/longbridge/config',
        draft,
      );
      setConnection(result.connection);
      setDraft({ appKey: '', appSecret: '', accessToken: '' });
      await loadQuotes(symbols, false);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDemo = async () => {
    setLoading(true);
    setError(null);
    try {
      await loadQuotes(symbols, true);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const positiveCount = useMemo(
    () => quotes.filter((quote) => (quote.change ?? 0) > 0).length,
    [quotes],
  );

  return (
    <div className="min-h-full bg-background px-4 py-5 sm:px-6 lg:px-8 lg:py-8">
      <div className="mx-auto max-w-7xl space-y-5">
        <PageHeader
          title="金融研究"
          subtitle="Longbridge 只读行情与证券数据工作台"
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refresh()}
              disabled={loading}
            >
              <RefreshCw
                className={loading ? 'size-4 animate-spin' : 'size-4'}
              />
              刷新
            </Button>
          }
        />

        {error && (
          <div className="rounded-xl border border-error/30 bg-error-bg px-4 py-3 text-sm text-error">
            {error}
          </div>
        )}

        <section className="rounded-2xl border border-brand-200 bg-brand-50/40 p-5 shadow-sm sm:p-6">
          <div className="grid gap-6 lg:grid-cols-[1fr_300px] lg:items-center">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-background/80 px-3 py-1 text-xs font-medium text-primary ring-1 ring-brand-200">
                <Activity className="size-3.5" />
                Research Agent · Read-only
              </div>
              <h2 className="max-w-2xl text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                让每个行情数字都能回到来源和时间
              </h2>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
                这里是 Longbridge
                的实际接入和展示入口。查询结果保留证券代码、市场、数据时间、抓取时间与来源标识，方便后续生成可复核的研究草稿。
              </p>
            </div>
            <div className="rounded-xl border border-border/80 bg-background/85 p-4 backdrop-blur">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs text-muted-foreground">Longbridge</p>
                  <p className="mt-1 text-lg font-semibold text-foreground">
                    {connectionLabel(connection)}
                  </p>
                </div>
                {connection?.configured ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-success-bg px-2.5 py-1 text-xs font-medium text-success">
                    <span className="size-1.5 rounded-full bg-success" />
                    Live API
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-warning-bg px-2.5 py-1 text-xs font-medium text-warning">
                    <WifiOff className="size-3.5" />
                    Demo
                  </span>
                )}
              </div>
              <p className="mt-3 text-xs leading-5 text-muted-foreground">
                {connection?.message ?? '正在读取连接状态…'}
              </p>
              {connection?.appKeyMasked && (
                <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                  App Key {connection.appKeyMasked}
                </p>
              )}
            </div>
          </div>
        </section>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-5">
            <Card>
              <CardHeader className="border-b border-border/70">
                <CardTitle className="flex items-center gap-2">
                  <Search className="size-4 text-primary" />
                  查询行情
                </CardTitle>
                <CardDescription>
                  使用 Longbridge 的 ticker.region
                  格式，可用逗号同时查询多只证券。
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-4">
                <form
                  className="flex flex-col gap-2 sm:flex-row"
                  onSubmit={handleQuery}
                >
                  <Input
                    aria-label="证券代码"
                    value={symbols}
                    onChange={(event) => setSymbols(event.target.value)}
                    placeholder="例如：0700.HK,AAPL.US"
                    className="font-mono"
                  />
                  <Button type="submit" disabled={loading} className="shrink-0">
                    {loading ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Search className="size-4" />
                    )}
                    查询
                  </Button>
                </form>
              </CardContent>
            </Card>

            <Card className="overflow-hidden">
              <CardHeader className="border-b border-border/70 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <CardTitle>行情快照</CardTitle>
                  <CardDescription className="mt-1">
                    {quoteStatus === 'live'
                      ? '实时数据 · Longbridge OpenAPI'
                      : quoteStatus === 'provider_unavailable'
                        ? '请求失败 · Longbridge OpenAPI'
                        : '演示数据 · 用于验证界面和证据字段'}
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="rounded-full bg-muted px-2 py-1">
                    {quotes.length} 个标的
                  </span>
                  <span>{positiveCount} 个上涨</span>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {quotes.length === 0 ? (
                  <div className="flex min-h-52 flex-col items-center justify-center px-4 text-center">
                    <Database className="mb-3 size-8 text-muted-foreground/50" />
                    <p className="text-sm font-medium text-foreground">
                      {quoteStatus === 'provider_unavailable'
                        ? 'Longbridge 暂时不可用'
                        : '暂无行情数据'}
                    </p>
                    <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
                      {quoteMessage || '请配置凭据后重试，或先加载演示数据。'}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-4"
                      onClick={() => void handleDemo()}
                    >
                      加载演示数据
                    </Button>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[720px] text-sm">
                      <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                        <tr>
                          <th className="px-4 py-3 font-medium">证券</th>
                          <th className="px-4 py-3 font-medium">最新价</th>
                          <th className="px-4 py-3 font-medium">涨跌</th>
                          <th className="px-4 py-3 font-medium">成交量</th>
                          <th className="px-4 py-3 font-medium">行情时间</th>
                          <th className="px-4 py-3 font-medium">证据状态</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/70">
                        {quotes.map((quote) => {
                          const isUp = (quote.change ?? 0) > 0;
                          const isDown = (quote.change ?? 0) < 0;
                          const changeClass = isUp
                            ? 'text-success'
                            : isDown
                              ? 'text-error'
                              : 'text-muted-foreground';
                          return (
                            <tr
                              key={quote.sourceId}
                              className="transition-colors hover:bg-muted/30"
                            >
                              <td className="px-4 py-3.5">
                                <div className="flex items-center gap-3">
                                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-xs font-semibold text-primary">
                                    {quote.market}
                                  </div>
                                  <div className="min-w-0">
                                    <p className="truncate font-medium text-foreground">
                                      {quote.name}
                                    </p>
                                    <p className="font-mono text-xs text-muted-foreground">
                                      {quote.symbol} ·{' '}
                                      {marketLabel(quote.market)}
                                    </p>
                                  </div>
                                </div>
                              </td>
                              <td className="px-4 py-3.5 font-mono font-medium text-foreground">
                                {formatPrice(quote.last)}
                              </td>
                              <td
                                className={`px-4 py-3.5 font-mono ${changeClass}`}
                              >
                                <span className="inline-flex items-center gap-1">
                                  {isUp && (
                                    <ArrowUpRight className="size-3.5" />
                                  )}
                                  {isDown && (
                                    <ArrowDownRight className="size-3.5" />
                                  )}
                                  {quote.change === null
                                    ? '—'
                                    : `${quote.change > 0 ? '+' : ''}${formatPrice(quote.change)} (${quote.changePercent?.toFixed(2) ?? '—'}%)`}
                                </span>
                              </td>
                              <td className="px-4 py-3.5 font-mono text-muted-foreground">
                                {formatCompact(quote.volume)}
                              </td>
                              <td className="px-4 py-3.5 text-xs text-muted-foreground">
                                {formatTime(quote.asOf)}
                              </td>
                              <td className="px-4 py-3.5">
                                <span
                                  className={`inline-flex rounded-full px-2 py-1 text-[11px] font-medium ${quote.evidenceStatus === 'complete' ? 'bg-success-bg text-success' : quote.evidenceStatus === 'demo' ? 'bg-warning-bg text-warning' : 'bg-muted text-muted-foreground'}`}
                                >
                                  {quote.evidenceStatus === 'complete'
                                    ? '来源完整'
                                    : quote.evidenceStatus === 'demo'
                                      ? '演示数据'
                                      : '部分字段'}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
              {quotes.length > 0 && (
                <div className="border-t border-border/70 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
                  <span>{quoteMessage || '数据已返回'}</span>
                  <span className="mx-2">·</span>
                  <span>
                    抓取于 {formatTime(quotes[0]?.retrievedAt ?? null)}
                  </span>
                </div>
              )}
            </Card>
          </div>

          <aside className="space-y-5">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <KeyRound className="size-4 text-primary" />
                  接入 Longbridge
                </CardTitle>
                <CardDescription>
                  凭据只保存在当前后端进程内，不会写入数据库或日志；重启后需重新输入。
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form className="space-y-3" onSubmit={handleConnect}>
                  <div className="space-y-1.5">
                    <Label htmlFor="longbridge-app-key">App Key</Label>
                    <Input
                      id="longbridge-app-key"
                      value={draft.appKey}
                      onChange={(event) =>
                        setDraft({ ...draft, appKey: event.target.value })
                      }
                      placeholder="Longbridge App Key"
                      autoComplete="off"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="longbridge-app-secret">App Secret</Label>
                    <Input
                      id="longbridge-app-secret"
                      type="password"
                      value={draft.appSecret}
                      onChange={(event) =>
                        setDraft({ ...draft, appSecret: event.target.value })
                      }
                      placeholder="Longbridge App Secret"
                      autoComplete="new-password"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="longbridge-access-token">
                      Access Token
                    </Label>
                    <Input
                      id="longbridge-access-token"
                      type="password"
                      value={draft.accessToken}
                      onChange={(event) =>
                        setDraft({ ...draft, accessToken: event.target.value })
                      }
                      placeholder="Longbridge Access Token"
                      autoComplete="new-password"
                    />
                  </div>
                  <Button type="submit" className="w-full" disabled={saving}>
                    {saving ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <ShieldCheck className="size-4" />
                    )}
                    保存并连接
                  </Button>
                </form>
                <div className="mt-4 flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-xs leading-5 text-muted-foreground">
                  <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" />
                  <span>
                    仅开放行情、资料、持仓和历史订单查询；交易工具默认关闭。
                  </span>
                </div>
                <div className="mt-3 flex items-center justify-between gap-3 text-xs">
                  <a
                    href="https://open.longbridge.com/docs/how-to-access-api"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    查看官方接入文档 <ExternalLink className="size-3" />
                  </a>
                  <button
                    type="button"
                    className="cursor-pointer text-muted-foreground hover:text-foreground"
                    onClick={() => void handleDemo()}
                  >
                    用演示数据
                  </button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>当前能力面</CardTitle>
                <CardDescription>Effective capability boundary</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {capabilities.map((capability) => (
                  <div
                    key={capability}
                    className="flex items-center justify-between rounded-lg border border-border/70 px-3 py-2.5 text-sm"
                  >
                    <span className="text-foreground">
                      {CAPABILITY_LABELS[capability] ?? capability}
                    </span>
                    <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-primary">
                      只读
                    </span>
                  </div>
                ))}
                {capabilities.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    正在读取能力配置…
                  </p>
                )}
              </CardContent>
            </Card>
          </aside>
        </div>
      </div>
    </div>
  );
}
