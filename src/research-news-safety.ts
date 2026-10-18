const ALLOWED_NEWS_SOURCE_KINDS = new Set([
  'issuer_announcement',
  'exchange_announcement',
  'licensed_news',
  'filing',
]);

export interface ResearchNewsSnapshotInput {
  sourceId: string;
  sourceKind: string;
  url: string;
  title: string;
  content: string;
  publishedAt: string | null;
  retrievedAt: string;
}

export interface ResearchNewsSnapshot {
  sourceId: string;
  sourceKind: string;
  url: string;
  title: string;
  content: string;
  publishedAt: string | null;
  retrievedAt: string;
  contentTrust: 'untrusted_external';
  promptInstructionsAllowed: false;
}

/**
 * Validate and freeze an external news/announcement snapshot before it can be
 * mapped to an EvidenceRef. This is intentionally provider-neutral: until a
 * real provider is configured, the research service continues to report a
 * missing capability rather than manufacture a snapshot.
 */
export function createResearchNewsSnapshot(
  input: ResearchNewsSnapshotInput,
  allowedHosts: readonly string[],
): ResearchNewsSnapshot {
  if (!ALLOWED_NEWS_SOURCE_KINDS.has(input.sourceKind)) {
    throw new Error('新闻来源类型不在 Folio 白名单中。');
  }
  const url = new URL(input.url);
  if (url.protocol !== 'https:') {
    throw new Error('新闻来源必须使用 HTTPS。');
  }
  if (
    !allowedHosts.some(
      (host) => host.toLowerCase() === url.hostname.toLowerCase(),
    )
  ) {
    throw new Error('新闻来源域名不在 Folio 白名单中。');
  }
  if (!input.sourceId.trim() || !input.title.trim() || !input.content.trim()) {
    throw new Error('新闻证据缺少来源、标题或原文内容。');
  }
  if (input.title.length > 1000 || input.content.length > 500_000) {
    throw new Error('新闻原文超过允许的快照大小。');
  }
  const clean = (value: string) =>
    value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  return {
    sourceId: input.sourceId.trim(),
    sourceKind: input.sourceKind,
    url: url.toString(),
    title: clean(input.title.trim()),
    content: clean(input.content),
    publishedAt: input.publishedAt,
    retrievedAt: input.retrievedAt,
    contentTrust: 'untrusted_external',
    promptInstructionsAllowed: false,
  };
}
