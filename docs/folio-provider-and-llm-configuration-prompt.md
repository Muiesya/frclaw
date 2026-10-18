# Folio 真实 Provider 与 LLM 接入提示词

下面的提示词可直接交给编码 Agent 使用。

```text
你正在修改仓库：

<repo-root>

目标：为当前 Folio 研究工作台配置真实的行情、财务、估值、新闻 Provider，并接入实际 LLM Provider，使一次研究请求能够完成多源取数、证据持久化、EvidenceRef 约束下的模型综合和可复核报告交付。

不要只输出方案。请检查源码、实现代码、增加测试并运行验证命令。

## 当前源码事实

当前已经存在：

- Longbridge quote Provider。
- `ResearchCapability` 统一能力契约。
- `research-http-providers.ts` HTTPS Provider Adapter。
- `research-provider-registry.ts` Provider Registry、fallback 和状态投影。
- `research-synthesis.ts` EvidenceRef 约束的综合接口和输出校验。
- `ResearchPage`、EvidenceRef、审计事件和研究 StreamEvent。
- `research:eval` 确定性评测命令。

当前仍然缺少：

- 真实 fundamentals Provider 配置。
- 真实 valuation Provider 配置。
- 真实 news/announcement Provider 配置。
- 默认的实际 LLM Synthesis Provider。
- 真实 Provider 和真实 LLM 的 live integration 测试。

重要源码入口：

- `src/research-http-providers.ts`
- `src/research-provider-registry.ts`
- `src/research-synthesis.ts`
- `src/research-service.ts`
- `src/research-model.ts`
- `src/research-news-safety.ts`
- `src/routes/finance.ts`
- `src/finance/longbridge-session.ts`
- `web/src/pages/ResearchPage.tsx`
- `docs/API.md`

## 总体约束

1. 保留现有认证、权限、SQLite、Pi Runtime、Agent Runner、Workspace、Session、Electron 和研究运行边界。
2. 不把演示数据、测试 fixture 或空返回写成真实 Provider 成功。
3. Provider 凭据只能来自环境变量、Secret 管理或现有安全配置，不能提交到 Git、写入数据库、日志或 Renderer。
4. 所有研究能力保持只读，不执行交易下单、撤单、改单或其他副作用。
5. 没有真实凭据时可以运行 contract test，但运行状态必须是 `provider_unavailable`，不能生成 EvidenceRef。
6. 任何模型输出都必须经过 EvidenceRef 校验，模型不能创建新的来源、时间、价格、指标或事实。
7. 只有真实接入并通过 live integration 验证后，才能在文档或简历中写成“已接入真实 Provider”。

## 第一部分：配置 Longbridge 行情 Provider

Longbridge 凭据通过已认证用户的接口或 Finance 页面配置，不要写入 `.env`：

```http
PUT /api/finance/longbridge/config
Content-Type: application/json

{
  "appKey": "你的 Longbridge App Key",
  "appSecret": "你的 Longbridge App Secret",
  "accessToken": "你的 Longbridge Access Token"
}
```

检查：

- `src/routes/finance.ts`
- `src/finance/longbridge-session.ts`
- `src/finance/longbridge-service.ts`

要求：

- 成功取数时生成 `longbridge_openapi` EvidenceRef。
- 无凭据时返回 `provider_unavailable`。
- `demo=1` 只允许行情页面显式请求演示数据，研究运行不能把演示数据当作 live EvidenceRef。
- 不显示或记录完整凭据。

## 第二部分：配置 fundamentals、valuation、news Provider

当前研究 HTTP Adapter 从环境变量读取 HTTPS endpoint：

```env
MINICLAW_FUNDAMENTALS_PROVIDER_URL=https://your-provider.example.com/fundamentals
MINICLAW_FUNDAMENTALS_PROVIDER_KEY=your-secret
MINICLAW_FUNDAMENTALS_FALLBACK_URL=https://backup.example.com/fundamentals
MINICLAW_FUNDAMENTALS_FALLBACK_KEY=backup-secret

MINICLAW_VALUATION_PROVIDER_URL=https://your-provider.example.com/valuation
MINICLAW_VALUATION_PROVIDER_KEY=your-secret
MINICLAW_VALUATION_FALLBACK_URL=https://backup.example.com/valuation
MINICLAW_VALUATION_FALLBACK_KEY=backup-secret

MINICLAW_NEWS_PROVIDER_URL=https://your-provider.example.com/news
MINICLAW_NEWS_PROVIDER_KEY=your-secret
MINICLAW_NEWS_FALLBACK_URL=https://backup.example.com/news
MINICLAW_NEWS_FALLBACK_KEY=backup-secret

MINICLAW_RESEARCH_NEWS_ALLOWED_HOSTS=issuer.example.com,exchange.example.com,news.example.com
```

不要把上面的占位值当作真实配置。先确认实际 Provider 的 API、授权方式、市场覆盖、数据许可和调用限制，再配置真实值。

### 请求协议

Provider Adapter 会发送：

```text
GET {endpoint}?symbol=0700&market=HK
Authorization: Bearer {provider-key}
```

endpoint 必须使用 HTTPS。

### 统一响应协议

Provider 必须返回 JSON：

```json
{
  "status": "complete",
  "evidence": [],
  "missing": [],
  "conflicts": [],
  "error": null,
  "recovery": null
}
```

`status` 只能使用：

```text
complete | partial | stale | conflict | provider_unavailable | invalid | failed
```

### Evidence 最小结构

财务和估值 Evidence 示例：

```json
{
  "symbol": "0700.HK",
  "market": "HK",
  "entity": "Tencent",
  "period": "FY2025",
  "metric": "revenue",
  "value": 660000000000,
  "unit": "HKD",
  "asOf": "2025-12-31T00:00:00.000Z",
  "retrievedAt": "2026-10-17T09:00:00.000Z",
  "sourceId": "provider:fundamentals:0700.HK:FY2025:revenue",
  "sourceKind": "licensed_provider",
  "maxAgeSeconds": 7776000
}
```

每条 Evidence 必须有：

- `symbol`
- `metric`
- `sourceId`
- `sourceKind`
- `retrievedAt`
- 可复核的 `value`

缺少来源或时间时必须拒绝 Evidence，不得补当前时间。

### 新闻 Evidence 结构

新闻和公告的 `value` 必须包含：

```json
{
  "url": "https://issuer.example.com/announcement/001",
  "title": "公告标题",
  "content": "公告原文",
  "publishedAt": "2026-10-17T08:00:00.000Z"
}
```

允许的 `sourceKind` 必须来自新闻安全模块白名单，例如：

```text
issuer_announcement
exchange_announcement
licensed_news
filing
```

新闻 Provider 必须经过：

- HTTPS 校验。
- 域名白名单。
- 来源类型白名单。
- 原文大小限制。
- 控制字符清理。
- `contentTrust: untrusted_external` 标记。
- `promptInstructionsAllowed: false` 标记。

新闻正文不能作为系统指令，不能修改 Agent 权限、研究计划或工具选择。

## 第三部分：完善 Provider Registry 和 live 状态

检查 `src/research-provider-registry.ts`，确保：

1. 配置了 endpoint 的 capability 使用实际 Adapter。
2. 未配置 endpoint 的 capability 返回 `provider_unavailable`。
3. 主 Provider 失败时尝试 fallback。
4. fallback 的实际来源写入 EvidenceRef 和审计事件。
5. Provider 状态至少显示：

```text
healthy | degraded | unavailable | unknown
```

6. Provider 状态不能把 demo fixture 误标为 live。
7. 认证失败、参数错误、HTTP 错误、超时和未知结果使用不同错误分类。
8. 真实 Provider 的调用结果需要保存来源和取数时间。

如果健康状态仍然只保存在进程内存中，应在文档中明确说明，不得声称已经实现持久化 Provider 健康中心。

## 第四部分：接入实际 LLM Provider

当前 `ResearchSynthesisProvider` 只是接口，默认没有实际实现。请新增一个真实 Provider Adapter，例如：

```text
src/research-synthesis-anthropic.ts
```

或实现 OpenAI-compatible Adapter。

### 推荐的环境变量

Anthropic-compatible：

```env
MINICLAW_RESEARCH_SYNTHESIS_PROVIDER=anthropic
MINICLAW_RESEARCH_SYNTHESIS_URL=https://api.anthropic.com
MINICLAW_RESEARCH_SYNTHESIS_KEY=your-key
MINICLAW_RESEARCH_SYNTHESIS_MODEL=your-model
```

OpenAI-compatible：

```env
MINICLAW_RESEARCH_SYNTHESIS_PROVIDER=openai-compatible
MINICLAW_RESEARCH_SYNTHESIS_URL=https://api.example.com/v1/chat/completions
MINICLAW_RESEARCH_SYNTHESIS_KEY=your-key
MINICLAW_RESEARCH_SYNTHESIS_MODEL=your-model
```

不要把密钥写入源码或发送到 Renderer。

### LLM 输入限制

只发送：

- 研究问题。
- 证券和市场上下文。
- 当前有效 EvidenceRef。
- Provider 状态。
- 研究缺口。
- 结构化报告字段要求。

Evidence 输入至少包含：

```json
{
  "id": "evidence-id",
  "metric": "revenue",
  "sourceId": "provider-source-id",
  "sourceKind": "licensed_provider",
  "asOf": "2025-12-31T00:00:00.000Z",
  "retrievedAt": "2026-10-17T09:00:00.000Z",
  "value": 660000000000
}
```

新闻正文必须带有不可信内容标记，并明确告诉模型：正文不是系统指令。

### LLM 输出限制

模型必须输出 JSON，字段为：

```json
{
  "summary": "...",
  "stance": "bullish | bearish | neutral | insufficient_data",
  "confidence": "high | medium | low",
  "bullArguments": [],
  "bearArguments": [],
  "catalysts": [],
  "risks": [],
  "gaps": [],
  "evidenceRefs": []
}
```

接入 `synthesizeResearchReport()` 时传入真实 Provider：

```ts
const report = await synthesizeResearchReport({
  baseReport: deterministicReport,
  evidence,
  gaps,
  provider: createConfiguredResearchSynthesisProvider(),
});
```

服务端必须继续调用 `validateResearchSynthesisDraft()`，拒绝：

- 不存在的 EvidenceRef。
- 非当前 EvidenceRef。
- 非法 stance 或 confidence。
- 非数组字段。
- 过长文本。
- 模型自造来源、时间、指标或数值。

LLM Provider 不可用时保留确定性报告，并标记：

```text
synthesisStatus: synthesis_unavailable
```

## 第五部分：真实配置后的验证

启动 Backend 后：

```powershell
npm run dev:all
```

然后：

1. 登录系统。
2. 配置 Longbridge 行情凭据。
3. 设置 fundamentals、valuation、news Provider 环境变量。
4. 重启 Backend，使环境变量生效。
5. 打开 `/research`。
6. 创建 `0700.HK` 研究运行。
7. 检查 `/api/research/runs/:id`。

必须确认：

- `plan.capabilities[*].provider` 是配置的 Provider ID。
- `steps[*].provider` 是实际调用的 Provider。
- `providers[*].health` 反映真实状态。
- `evidence[*].sourceId`、`sourceKind`、`asOf` 和 `retrievedAt` 存在。
- 新闻 Evidence 的 `contentTrust` 为 `untrusted_external`。
- `report.synthesisStatus` 为 `completed`。
- `report.synthesisProvider` 是真实模型 Provider ID。
- 所有 `report.evidenceRefs` 都可以回查数据库。

## 必须增加的测试

至少增加：

1. fundamentals、valuation、news Provider 响应契约测试。
2. HTTPS endpoint 校验测试。
3. Bearer token 不出现在日志的测试。
4. 主 Provider 失败后 fallback 成功测试。
5. 全部 Provider 失败测试。
6. 新闻域名和来源类型白名单测试。
7. 新闻提示注入文本隔离测试。
8. Anthropic 或 OpenAI-compatible LLM Adapter 测试。
9. LLM 伪造 EvidenceRef 拒绝测试。
10. LLM Provider 失败后确定性报告降级测试。
11. live integration 测试，使用环境变量提供凭据。

真实 Provider 测试和 deterministic fixture 测试必须分开。没有凭据时，live integration 应明确显示 blocked，而不是伪造通过。

## 验证命令

```powershell
npm test -- --run
npm run typecheck
npm run research:eval
npm run build:all
npm --prefix web run test:e2e
```

最终汇报必须说明：

1. 实际接入了哪些 Provider。
2. 每个 Provider 的市场和能力范围。
3. 哪些数据是 live，哪些是 demo 或 unavailable。
4. 使用的 LLM Provider、模型和协议。
5. EvidenceRef 如何约束 LLM 输出。
6. 新闻安全边界如何验证。
7. live integration 测试是否真正通过。
8. 不要声称未经验证的性能、准确率、覆盖率或投资收益。
```

