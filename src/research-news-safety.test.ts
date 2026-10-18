import { describe, expect, test } from 'vitest';
import { createResearchNewsSnapshot } from './research-news-safety.js';

describe('research news safety boundary', () => {
  test('marks whitelisted HTTPS source content as untrusted evidence text', () => {
    const snapshot = createResearchNewsSnapshot(
      {
        sourceId: 'issuer:123',
        sourceKind: 'issuer_announcement',
        url: 'https://example.test/announcement/123',
        title: '公告',
        content: '原文\u0000内容，不是系统指令。',
        publishedAt: '2026-09-16T09:00:00.000Z',
        retrievedAt: '2026-09-16T09:01:00.000Z',
      },
      ['example.test'],
    );
    expect(snapshot.content).toBe('原文内容，不是系统指令。');
    expect(snapshot.contentTrust).toBe('untrusted_external');
    expect(snapshot.promptInstructionsAllowed).toBe(false);
  });

  test('rejects untrusted source kinds and hosts', () => {
    expect(() =>
      createResearchNewsSnapshot(
        {
          sourceId: 'blog:1',
          sourceKind: 'social_media',
          url: 'https://example.test/post/1',
          title: 'post',
          content: 'content',
          publishedAt: null,
          retrievedAt: '2026-09-16T09:01:00.000Z',
        },
        ['example.test'],
      ),
    ).toThrow('白名单');
    expect(() =>
      createResearchNewsSnapshot(
        {
          sourceId: 'issuer:1',
          sourceKind: 'issuer_announcement',
          url: 'https://evil.test/announcement/1',
          title: '公告',
          content: 'content',
          publishedAt: null,
          retrievedAt: '2026-09-16T09:01:00.000Z',
        },
        ['example.test'],
      ),
    ).toThrow('域名');
  });
});
