// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../api/client', () => ({
  api: {
    get: mocks.get,
    put: mocks.put,
    delete: mocks.delete,
  },
}));

vi.mock('@/components/common/PageHeader', () => ({
  PageHeader: ({ title, subtitle }: { title: string; subtitle?: string }) => (
    <header>
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
    </header>
  ),
}));

const { FinancePage } = await import('./FinancePage');

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

describe('FinancePage', () => {
  test('shows the connection state and quote evidence table', async () => {
    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/api/finance/longbridge/status') {
        return {
          connection: {
            configured: false,
            mode: 'demo',
            source: 'demo',
            message: '未配置 Longbridge 凭据，当前使用演示数据。',
            appKeyMasked: null,
          },
          capabilities: ['quote', 'security', 'positions', 'historical_orders'],
          tradingEnabled: false,
        };
      }
      return {
        status: 'demo',
        source: 'demo',
        retrievedAt: '2026-09-16T09:00:00.000Z',
        message: '当前为演示数据，不代表真实行情。',
        quotes: [
          {
            symbol: '0700.HK',
            market: 'HK',
            name: '腾讯控股',
            last: 512.4,
            prevClose: 500,
            change: 12.4,
            changePercent: 2.48,
            volume: 12345600,
            turnover: 6323456789,
            tradeStatus: '正常交易',
            asOf: '2026-09-16T09:00:00.000Z',
            retrievedAt: '2026-09-16T09:00:00.000Z',
            source: 'demo',
            evidenceStatus: 'demo',
            sourceId: 'demo:quote:0700.HK',
          },
        ],
      };
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const router = createMemoryRouter(
      [{ path: '/finance', element: <FinancePage /> }],
      { initialEntries: ['/finance'] },
    );

    await act(async () => {
      root!.render(<RouterProvider router={router} />);
    });

    await vi.waitFor(() => {
      expect(container!.textContent).toContain('金融研究');
      expect(container!.textContent).toContain('未连接');
      expect(container!.textContent).toContain('腾讯控股');
      expect(container!.textContent).toContain('演示数据');
    });
  });
});
