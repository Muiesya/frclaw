import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { createLongbridgeReadOnlyIpcCapability } from '../src/finance/longbridge-ipc.js';

function waitBriefly(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Longbridge Agent IPC capability', () => {
  test('sends only a read-only query and consumes the host result', async () => {
    const ipcRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'miniclaw-finance-ipc-'),
    );
    try {
      const capability = createLongbridgeReadOnlyIpcCapability({
        workspaceIpc: ipcRoot,
        currentInputTurnId: 'turn-1',
        currentSessionId: 'session-1',
      });
      const resultPromise = capability.getQuote(
        { symbol: '0700', market: 'HK' },
        new AbortController().signal,
      );

      const tasksDir = path.join(ipcRoot, 'tasks');
      let requestPath: string | undefined;
      for (let attempt = 0; attempt < 50 && !requestPath; attempt += 1) {
        const entries = fs.existsSync(tasksDir)
          ? fs.readdirSync(tasksDir).filter((entry) => entry.endsWith('.json'))
          : [];
        requestPath = entries[0] ? path.join(tasksDir, entries[0]) : undefined;
        if (!requestPath) await waitBriefly(10);
      }
      expect(requestPath).toBeDefined();

      const request = JSON.parse(fs.readFileSync(requestPath!, 'utf8')) as {
        type: string;
        operation: string;
        symbol: string;
        market: string;
        inputTurnId: string;
        sessionId: string;
        requestId: string;
      };
      expect(request).toMatchObject({
        type: 'finance_read_only',
        operation: 'get_quote',
        symbol: '0700',
        market: 'HK',
        inputTurnId: 'turn-1',
        sessionId: 'session-1',
      });
      expect(JSON.stringify(request)).not.toContain('accessToken');
      expect(JSON.stringify(request)).not.toContain('appSecret');

      const result = {
        status: 'complete' as const,
        evidence: [
          {
            symbol: '0700.HK',
            market: 'HK',
            metric: 'quote',
            asOf: '2026-09-16T08:30:00.000Z',
            retrievedAt: '2026-09-16T09:00:00.000Z',
            sourceId: 'longbridge:quote:0700.HK',
            sourceKind: 'longbridge_openapi',
            value: { last: 512.4 },
          },
        ],
        missing: [],
        conflicts: [],
      };
      fs.writeFileSync(
        path.join(
          tasksDir,
          `finance_read_only_result_${request.requestId}.json`,
        ),
        JSON.stringify({ success: true, result }),
      );

      await expect(resultPromise).resolves.toEqual(result);
    } finally {
      fs.rmSync(ipcRoot, { recursive: true, force: true });
    }
  });
});
