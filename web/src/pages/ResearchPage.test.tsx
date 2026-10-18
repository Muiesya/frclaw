// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('../api/client', () => ({ api: mocks }));
vi.mock('@/components/common/PageHeader', () => ({
  PageHeader: ({ title, subtitle }: { title: string; subtitle?: string }) => (
    <header>
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
    </header>
  ),
}));

const { ResearchPage } = await import('./ResearchPage');

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

describe('ResearchPage', () => {
  test('loads history, progress, provider state and EvidenceRef detail', async () => {
    const summary = {
      id: 'run-1',
      symbol: '0700.HK',
      question: '研究风险',
      status: 'partial',
      attempt: 1,
      startedAt: '2026-09-16T09:00:00.000Z',
      createdAt: '2026-09-16T09:00:00.000Z',
      updatedAt: '2026-09-16T09:01:00.000Z',
      completedAt: '2026-09-16T09:01:00.000Z',
    };
    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/api/research/runs') return { runs: [summary] };
      return {
        run: {
          ...summary,
          plan: {
            version: 1,
            generatedAt: '2026-09-16T09:00:00.000Z',
            capabilities: [
              { capability: 'quote', label: '行情', provider: 'longbridge', required: true },
            ],
          },
          steps: [
            {
              id: 'step-1',
              capability: 'quote',
              provider: 'longbridge',
              status: 'completed',
              attempt: 1,
              timeoutMs: 15000,
              maxAttempts: 2,
              durationMs: 120,
              errorMessage: null,
            },
          ],
          providers: [
            {
              id: 'longbridge',
              health: 'healthy',
              capabilities: ['quote'],
              message: '已配置',
              checkedAt: '2026-09-16T09:00:00.000Z',
            },
          ],
          evidence: [
            {
              id: 'evidence-1',
              stepId: 'step-1',
              metric: 'quote',
              sourceId: 'longbridge:quote:0700.HK',
              sourceKind: 'longbridge_openapi',
              contentTrust: 'licensed_provider',
              asOf: '2026-09-16T09:00:00.000Z',
              retrievedAt: '2026-09-16T09:00:01.000Z',
              retrievalLatencySeconds: 1,
              ageSeconds: 1,
              maxAgeSeconds: 3600,
              isStale: false,
              value: { last: 512.4 },
            },
          ],
          report: {
            status: 'partial',
            summary: '部分数据',
            stance: 'neutral',
            confidence: 'low',
            bullArguments: [],
            bearArguments: [],
            catalysts: [],
            risks: [],
            gaps: ['fundamentals'],
            evidenceRefs: ['evidence-1'],
          },
          audit: [],
        },
      };
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const router = createMemoryRouter(
      [{ path: '/research', element: <ResearchPage /> }],
      { initialEntries: ['/research'] },
    );

    await act(async () => {
      root!.render(<RouterProvider router={router} />);
    });

    await vi.waitFor(() => {
      expect(container!.textContent).toContain('0700.HK');
      expect(container!.textContent).toContain('执行进度');
      expect(container!.textContent).toContain('Provider 状态');
      expect(container!.textContent).toContain('EvidenceRef evidence-1');
    });
  });
});
