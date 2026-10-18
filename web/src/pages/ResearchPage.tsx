import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Clock3,
  FileSearch,
  Loader2,
  PauseCircle,
  Play,
  RotateCcw,
} from 'lucide-react';
import { api } from '../api/client';
import { wsManager } from '../api/ws';
import { PageHeader } from '@/components/common/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

type RunStatus =
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
interface Evidence {
  id: string;
  stepId: string;
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
  retrievalLatencySeconds: number | null;
  ageSeconds: number | null;
  maxAgeSeconds: number | null;
  isStale: boolean | null;
  attempt?: number;
  value: unknown;
}
interface Step {
  id: string;
  capability: string;
  provider: string;
  status: string;
  attempt: number;
  timeoutMs: number;
  maxAttempts: number;
  durationMs: number;
  errorMessage: string | null;
}
interface Report {
  status: 'complete' | 'partial' | 'failed' | 'cancelled';
  summary: string;
  stance: string;
  confidence: string;
  bullArguments: string[];
  bearArguments: string[];
  catalysts: string[];
  risks: string[];
  gaps: string[];
  evidenceRefs: string[];
  synthesisStatus?: 'deterministic' | 'completed' | 'synthesis_unavailable';
  synthesisProvider?: string;
}
interface ResearchRunSummary {
  id: string;
  symbol: string;
  question: string;
  status: RunStatus;
  attempt: number;
  startedAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface AuditEvent {
  id: string;
  eventType: string;
  attempt: number;
  details: Record<string, unknown>;
  createdAt: string;
}

interface ProviderStatus {
  id: string;
  health: 'healthy' | 'degraded' | 'unavailable' | 'unknown';
  capabilities: string[];
  message: string;
  checkedAt: string;
}

interface ResearchRunDetail extends ResearchRunSummary {
  plan: {
    version: number;
    generatedAt: string;
    capabilities: Array<{
      capability: string;
      label: string;
      provider: string;
      required: boolean;
    }>;
  };
  steps: Step[];
  evidence: Evidence[];
  report: Report | null;
  audit: AuditEvent[];
  providers: ProviderStatus[];
}

const statusLabel: Record<RunStatus, string> = {
  planned: '已规划',
  queued: '排队中',
  running: '执行中',
  retry_wait: '等待重试',
  uncertain: '结果待确认',
  manual_reconciliation: '待人工处理',
  completed: '完整',
  partial: '部分成功',
  failed: '失败',
  cancelled: '已取消',
};

function statusVariant(
  status: RunStatus,
): 'success' | 'warning' | 'error' | 'info' | 'neutral' {
  if (status === 'completed') return 'success';
  if (status === 'partial') return 'warning';
  if (status === 'failed') return 'error';
  if (status === 'running' || status === 'queued' || status === 'retry_wait')
    return 'info';
  if (status === 'uncertain' || status === 'manual_reconciliation')
    return 'warning';
  return 'neutral';
}

function formatTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN');
}

function stepLabel(capability: string): string {
  return (
    {
      quote: '行情',
      fundamentals: '财务',
      valuation: '估值',
      news: '新闻/公告',
    }[capability] ?? capability
  );
}

function stepStatusLabel(status: string): string {
  return (
    {
      queued: '排队中',
      running: '执行中',
      completed: '已完成',
      partial: '部分结果',
      provider_unavailable: 'Provider 不可用',
      stale: '数据过期',
      conflict: '来源冲突',
      invalid: '参数无效',
      retry_wait: '等待重试',
      uncertain: '结果待确认',
      failed: '失败',
      cancelled: '已取消',
    }[status] ?? status
  );
}

function providerHealthLabel(health: ProviderStatus['health']): string {
  return {
    healthy: '可用',
    degraded: '降级',
    unavailable: '不可用',
    unknown: '未知',
  }[health];
}

export function ResearchPage() {
  const [runs, setRuns] = useState<ResearchRunSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ResearchRunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailRequestRef = useRef(0);
  const [symbol, setSymbol] = useState('0700.HK');
  const [question, setQuestion] = useState(
    '当前公开市场研究中，主要多空因素和数据缺口是什么？',
  );
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = async (preferredId?: string) => {
    const result = await api.get<{ runs: ResearchRunSummary[] }>(
      '/api/research/runs',
    );
    setRuns(result.runs);
    const nextId = preferredId ?? selectedId ?? result.runs[0]?.id ?? null;
    if (nextId && nextId !== selectedId) setSelectedId(nextId);
    if (!nextId) {
      setSelected(null);
      setSelectedId(null);
    }
  };

  const loadDetail = async (runId: string) => {
    const requestId = ++detailRequestRef.current;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const result = await api.get<{ run: ResearchRunDetail }>(
        `/api/research/runs/${encodeURIComponent(runId)}`,
      );
      if (requestId !== detailRequestRef.current) return;
      setSelected(result.run);
      setRuns((current) =>
        current.map((run) =>
          run.id === runId ? { ...run, ...result.run } : run,
        ),
      );
    } catch (err: unknown) {
      if (requestId !== detailRequestRef.current) return;
      setDetailError(err instanceof Error ? err.message : '无法读取研究详情。');
    } finally {
      if (requestId === detailRequestRef.current) setDetailLoading(false);
    }
  };

  useEffect(() => {
    void loadRuns()
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : '无法读取研究运行。'),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    setSelected(null);
    void loadDetail(selectedId);
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    const unsubscribe = wsManager.on('research_event', (message) => {
      const runId = message?.event?.research?.runId;
      if (runId === selectedId) void loadDetail(selectedId);
    });
    return () => {
      unsubscribe();
    };
  }, [selectedId]);

  useEffect(() => {
    if (
      !selectedId ||
      !selected ||
      ![
        'planned',
        'queued',
        'running',
        'retry_wait',
        'uncertain',
        'manual_reconciliation',
      ].includes(selected.status)
    )
      return;
    const timer = window.setInterval(() => {
      void loadDetail(selectedId);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [selectedId, selected?.status]);

  const startResearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.post<{ run: ResearchRunDetail }>(
        '/api/research/runs',
        { symbol, question },
        undefined,
        { 'Idempotency-Key': crypto.randomUUID() },
      );
      setSelectedId(result.run.id);
      await loadRuns(result.run.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法发起研究。');
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async () => {
    if (!selected) return;
    await api.post(
      `/api/research/runs/${encodeURIComponent(selected.id)}/cancel`,
    );
    await loadRuns(selected.id);
    await loadDetail(selected.id);
  };

  const resume = async () => {
    if (!selected) return;
    await api.post(
      `/api/research/runs/${encodeURIComponent(selected.id)}/resume`,
    );
    await loadRuns(selected.id);
    await loadDetail(selected.id);
  };

  const completedSteps =
    selected?.steps.filter((step) =>
      [
        'completed',
        'partial',
        'provider_unavailable',
        'stale',
        'conflict',
        'invalid',
        'failed',
        'cancelled',
      ].includes(step.status),
    ).length ?? 0;
  const progressTotal = selected?.steps.length ?? 0;
  const progressPercent = progressTotal
    ? Math.round((completedSteps / progressTotal) * 100)
    : 0;

  return (
    <div className="min-h-full bg-background px-4 py-5 sm:px-6 lg:px-8 lg:py-8">
      <div className="mx-auto max-w-7xl space-y-5">
        <PageHeader
          title="Folio 研究工作台"
          subtitle="只读研究运行、证据引用与可恢复执行轨迹"
        />
        {error && (
          <div
            role="alert"
            className="rounded-xl border border-error/30 bg-error-bg px-4 py-3 text-sm text-error"
          >
            {error}
          </div>
        )}
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        >
          {selected
            ? `${selected.symbol} 研究${statusLabel[selected.status]}，${completedSteps}/${progressTotal} 项能力已处理`
            : ''}
        </div>

        <div className="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
          <div className="space-y-5">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileSearch className="size-4 text-primary" />
                  发起研究
                </CardTitle>
              </CardHeader>
              <CardContent>
                <form className="space-y-4" onSubmit={startResearch}>
                  <div className="space-y-1.5">
                    <Label htmlFor="research-symbol">证券代码</Label>
                    <Input
                      id="research-symbol"
                      value={symbol}
                      onChange={(event) => setSymbol(event.target.value)}
                      placeholder="0700.HK"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="research-question">研究问题</Label>
                    <Textarea
                      id="research-question"
                      value={question}
                      onChange={(event) => setQuestion(event.target.value)}
                      rows={5}
                      placeholder="例如：未来一个季度的主要风险是什么？"
                    />
                  </div>
                  <p className="text-xs leading-5 text-muted-foreground">
                    第一阶段仅支持港股。系统会先规划行情、财务、估值和新闻能力。未配置的
                    Provider 会显示为研究缺口，不会用零值填充。
                  </p>
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={submitting}
                  >
                    {submitting ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Play className="size-4" />
                    )}
                    开始只读研究
                  </Button>
                </form>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>研究历史</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {loading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    读取中…
                  </div>
                ) : runs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    还没有研究运行。
                  </p>
                ) : (
                  runs.map((run) => (
                    <button
                      key={run.id}
                      type="button"
                      onClick={() => {
                        setDetailError(null);
                        setSelected(null);
                        setSelectedId(run.id);
                      }}
                      className={`w-full rounded-lg border p-3 text-left transition-colors ${selected?.id === run.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-sm font-medium">
                          {run.symbol}
                        </span>
                        <Badge variant={statusVariant(run.status)}>
                          {statusLabel[run.status]}
                        </Badge>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {run.question}
                      </p>
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        更新于 {formatTime(run.updatedAt)}
                      </p>
                    </button>
                  ))
                )}
              </CardContent>
            </Card>
          </div>

          <div className="space-y-5">
            {selectedId && detailLoading && !selected ? (
              <Card>
                <CardContent className="flex min-h-80 flex-col items-center justify-center text-center">
                  <Loader2 className="size-9 animate-spin text-primary" />
                  <p className="mt-3 text-sm font-medium">读取研究详情…</p>
                </CardContent>
              </Card>
            ) : detailError && selectedId ? (
              <Card>
                <CardContent className="flex min-h-80 flex-col items-center justify-center text-center">
                  <AlertTriangle className="size-9 text-error" />
                  <p className="mt-3 text-sm font-medium">研究详情读取失败</p>
                  <p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">
                    {detailError}
                  </p>
                  <Button
                    className="mt-4"
                    variant="outline"
                    onClick={() => void loadDetail(selectedId)}
                  >
                    重试
                  </Button>
                </CardContent>
              </Card>
            ) : !selected ? (
              <Card>
                <CardContent className="flex min-h-80 flex-col items-center justify-center text-center">
                  <CircleDashed className="size-9 text-muted-foreground/50" />
                  <p className="mt-3 text-sm font-medium">
                    选择证券并发起一次研究
                  </p>
                  <p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">
                    运行完成后，这里会显示计划、能力状态、证据时效和结构化报告。
                  </p>
                </CardContent>
              </Card>
            ) : (
              <>
                <Card>
                  <CardHeader className="flex-row items-start justify-between gap-4">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <span className="font-mono">{selected.symbol}</span>
                        <Badge variant={statusVariant(selected.status)}>
                          {statusLabel[selected.status]}
                        </Badge>
                      </CardTitle>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        研究计划 v{selected.plan.version} · 生成于{' '}
                        {formatTime(selected.plan.generatedAt)} ·{' '}
                        {selected.plan.capabilities.length} 项能力
                      </p>
                      <div className="mt-3 max-w-xl" aria-label="研究进度">
                        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                          <span>执行进度</span>
                          <span>
                            {completedSteps}/{progressTotal} 项已处理
                          </span>
                        </div>
                        <div
                          className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted"
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={progressPercent}
                        >
                          <div
                            className="h-full rounded-full bg-primary transition-[width] duration-300"
                            style={{ width: `${progressPercent}%` }}
                          />
                        </div>
                      </div>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {selected.question}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      {[
                        'planned',
                        'queued',
                        'running',
                        'retry_wait',
                        'uncertain',
                        'manual_reconciliation',
                      ].includes(selected.status) && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void cancel()}
                        >
                          <PauseCircle className="size-4" />
                          取消
                        </Button>
                      )}
                      {[
                        'partial',
                        'failed',
                        'cancelled',
                        'uncertain',
                        'manual_reconciliation',
                      ].includes(selected.status) && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void resume()}
                        >
                          <RotateCcw className="size-4" />
                          恢复
                        </Button>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="grid gap-2 sm:grid-cols-4">
                      {selected.steps.map((step) => (
                        <div
                          key={step.id}
                          className="rounded-lg border border-border p-3"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium">
                              {stepLabel(step.capability)}
                            </span>
                            {step.status === 'completed' ? (
                              <CheckCircle2
                                className="size-4 text-success"
                                aria-hidden="true"
                              />
                            ) : step.status === 'running' ? (
                              <Loader2
                                className="size-4 animate-spin text-primary"
                                aria-hidden="true"
                              />
                            ) : [
                                'provider_unavailable',
                                'stale',
                                'conflict',
                                'invalid',
                              ].includes(step.status) ? (
                              <AlertTriangle
                                className="size-4 text-warning"
                                aria-hidden="true"
                              />
                            ) : (
                              <CircleDashed
                                className="size-4 text-muted-foreground"
                                aria-hidden="true"
                              />
                            )}
                          </div>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {step.provider} · {stepStatusLabel(step.status)} ·
                            第 {step.attempt}/{step.maxAttempts} 次尝试
                          </p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {step.durationMs > 0
                              ? `${step.durationMs} ms`
                              : '尚未完成'}
                            {step.errorMessage ? ` · ${step.errorMessage}` : ''}
                          </p>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Provider 状态</CardTitle>
                  </CardHeader>
                  <CardContent className="grid gap-2 sm:grid-cols-2">
                    {selected.providers.map((provider) => (
                      <div
                        key={provider.id}
                        className="rounded-lg border border-border p-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-sm font-medium">
                            {provider.id}
                          </span>
                          <Badge
                            variant={
                              provider.health === 'healthy'
                                ? 'success'
                                : provider.health === 'degraded'
                                  ? 'warning'
                                  : 'neutral'
                            }
                          >
                            {providerHealthLabel(provider.health)}
                          </Badge>
                        </div>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          {provider.message}
                        </p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          能力：
                          {provider.capabilities.map(stepLabel).join('、')}
                        </p>
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Clock3 className="size-4 text-primary" />
                      执行审计时间线
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {selected.audit.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        暂无审计事件。
                      </p>
                    ) : (
                      <ol className="relative space-y-4 border-l border-border pl-5">
                        {selected.audit.map((event) => (
                          <li key={event.id} className="relative">
                            <span className="absolute -left-[25px] top-1 size-2 rounded-full bg-primary" />
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium">
                                {auditEventLabel(event.eventType)}
                              </span>
                              <Badge variant="neutral">
                                attempt {event.attempt}
                              </Badge>
                              <span className="text-[11px] text-muted-foreground">
                                {formatTime(event.createdAt)}
                              </span>
                            </div>
                            {Object.keys(event.details).length > 0 && (
                              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                {formatAuditDetails(event.details)}
                              </p>
                            )}
                          </li>
                        ))}
                      </ol>
                    )}
                  </CardContent>
                </Card>

                {selected.report && (
                  <Card>
                    <CardHeader>
                      <CardTitle>结构化研究报告</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="rounded-lg border border-border bg-muted/20 p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge
                            variant={
                              selected.report.status === 'complete'
                                ? 'success'
                                : selected.report.status === 'failed'
                                  ? 'error'
                                  : selected.report.status === 'cancelled'
                                    ? 'neutral'
                                    : 'warning'
                            }
                          >
                            {selected.report.status === 'complete'
                              ? '完整报告'
                              : selected.report.status === 'partial'
                                ? '部分报告'
                                : selected.report.status === 'cancelled'
                                  ? '已取消'
                                  : '失败报告'}
                          </Badge>
                          <span className="text-sm">
                            立场：{selected.report.stance}
                          </span>
                          <span className="text-sm">
                            置信度：{selected.report.confidence}
                          </span>
                          <Badge
                            variant={
                              selected.report.synthesisStatus === 'completed'
                                ? 'success'
                                : 'neutral'
                            }
                          >
                            {selected.report.synthesisStatus === 'completed'
                              ? `Agent 综合 · ${selected.report.synthesisProvider ?? 'provider'}`
                              : selected.report.synthesisStatus ===
                                  'synthesis_unavailable'
                                ? 'Agent 综合不可用'
                                : '确定性证据报告'}
                          </Badge>
                        </div>
                        <p className="mt-3 text-sm leading-6">
                          {selected.report.summary}
                        </p>
                      </div>
                      <ReportList
                        title="多方论据"
                        items={selected.report.bullArguments}
                      />
                      <ReportList
                        title="空方论据"
                        items={selected.report.bearArguments}
                      />
                      <ReportList
                        title="催化剂"
                        items={selected.report.catalysts}
                      />
                      <ReportList title="风险" items={selected.report.risks} />
                      <ReportList
                        title="研究缺口"
                        items={selected.report.gaps}
                        warning
                      />
                      <section>
                        <h3 className="text-sm font-medium">报告证据引用</h3>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {selected.report.evidenceRefs.map((id) => (
                            <button
                              key={id}
                              type="button"
                              className="rounded border border-primary/30 px-2 py-1 font-mono text-[11px] text-primary hover:bg-primary/5"
                              onClick={() =>
                                document
                                  .getElementById(`evidence-${id}`)
                                  ?.scrollIntoView({
                                    behavior: 'smooth',
                                    block: 'center',
                                  })
                              }
                            >
                              {id}
                            </button>
                          ))}
                        </div>
                      </section>
                    </CardContent>
                  </Card>
                )}

                <Card>
                  <CardHeader>
                    <CardTitle>证据与取数轨迹</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {selected.evidence.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        暂未产生证据。Provider 失败不会生成虚假证据。
                      </p>
                    ) : (
                      <div className="space-y-3">
                        {selected.evidence.map((item) => (
                          <div
                            key={item.id}
                            id={`evidence-${item.id}`}
                            className="rounded-lg border border-border p-3 scroll-mt-6"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="text-sm font-medium">
                                {item.metric}
                              </span>
                              <Badge
                                variant={
                                  item.isStale
                                    ? 'warning'
                                    : item.contentTrust === 'untrusted_external'
                                      ? 'warning'
                                      : item.sourceKind === 'demo_fixture'
                                        ? 'warning'
                                        : 'success'
                                }
                              >
                                {item.isStale
                                  ? '已过期'
                                  : item.contentTrust === 'untrusted_external'
                                    ? '外部不可信材料'
                                    : item.sourceKind === 'demo_fixture'
                                      ? '演示数据'
                                      : '真实来源'}
                              </Badge>
                            </div>
                            <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">
                              EvidenceRef {item.id} · {item.sourceId}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              行情时间：{formatTime(item.asOf)} · 取数时间：
                              {formatTime(item.retrievedAt)} · 取数延迟：
                              {item.retrievalLatencySeconds === null
                                ? '未知'
                                : `${item.retrievalLatencySeconds} 秒`}{' '}
                              · 数据年龄：
                              {item.ageSeconds === null
                                ? '未知'
                                : `${item.ageSeconds} 秒`}{' '}
                              ·{' '}
                              {item.isStale === null
                                ? '未配置过期阈值'
                                : item.isStale
                                  ? `已过期（阈值 ${item.maxAgeSeconds} 秒）`
                                  : `未过期（阈值 ${item.maxAgeSeconds} 秒）`}
                            </p>
                            <pre className="mt-2 overflow-x-auto rounded bg-muted/50 p-2 text-[11px]">
                              {JSON.stringify(item.value, null, 2)}
                            </pre>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function auditEventLabel(eventType: string): string {
  return (
    {
      run_created: '研究创建',
      run_queued: '运行入队',
      run_claimed: '运行领取',
      capability_started: '能力开始',
      capability_completed: '能力完成',
      provider_failed: 'Provider 失败',
      provider_result_uncertain: 'Provider 结果未知',
      capability_retry_wait: '等待有限重试',
      run_needs_reconciliation: '需要结果复核',
      capability_commit_rejected: '能力结果写入被拒绝',
      run_cancelled: '运行取消',
      run_completed: '运行完成',
      run_recovered: '运行恢复',
    }[eventType] ?? eventType
  );
}

function formatAuditDetails(details: Record<string, unknown>): string {
  return Object.entries(details)
    .filter(
      ([, value]) => value !== null && value !== undefined && value !== '',
    )
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
    )
    .join(' · ');
}

function ReportList({
  title,
  items,
  warning = false,
}: {
  title: string;
  items: string[];
  warning?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <h3
        className={`text-sm font-medium ${warning ? 'text-warning' : 'text-foreground'}`}
      >
        {title}
      </h3>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-muted-foreground">
        {items.map((item, index) => (
          <li key={`${title}-${index}`}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
