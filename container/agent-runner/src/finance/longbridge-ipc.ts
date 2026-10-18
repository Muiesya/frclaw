import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  FinanceHistoricalOrdersQuery,
  FinancePositionsQuery,
  FinanceSymbolQuery,
  LongbridgeReadOnlyCapability,
} from './longbridge-readonly.js';
import type { FinanceToolResult } from './finance-evidence.js';

const RESULT_PREFIX = 'finance_read_only_result';
const REQUEST_TIMEOUT_MS = 30_000;

interface FinanceIpcContext {
  workspaceIpc: string;
  currentInputTurnId?: string | null;
  currentTaskId?: string | null;
  currentSessionId?: string | null;
}

function unavailable(code: string, message: string): FinanceToolResult {
  return {
    status: 'provider_unavailable',
    evidence: [],
    missing: [],
    conflicts: [],
    error: { code, message },
    recovery: '检查工作台与宿主进程的连接后重试。',
  };
}

function writeRequest(
  tasksDir: string,
  request: Record<string, unknown> & { requestId: string },
): void {
  fs.mkdirSync(tasksDir, { recursive: true });
  const requestPath = path.join(tasksDir, `${request.requestId}.json`);
  const tempPath = `${requestPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(request), {
    flag: 'wx',
    mode: 0o600,
  });
  try {
    fs.renameSync(tempPath, requestPath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw error;
  }
}

async function callFinanceIpc(
  ctx: FinanceIpcContext,
  operation:
    | 'get_quote'
    | 'get_security'
    | 'get_positions'
    | 'get_historical_orders',
  payload: Record<string, unknown>,
  signal: AbortSignal,
): Promise<FinanceToolResult> {
  const requestId = crypto.randomUUID();
  const tasksDir = path.join(ctx.workspaceIpc, 'tasks');
  const resultPath = path.join(tasksDir, `${RESULT_PREFIX}_${requestId}.json`);
  try {
    writeRequest(tasksDir, {
      ...payload,
      type: 'finance_read_only',
      operation,
      requestId,
      inputTurnId: ctx.currentInputTurnId || undefined,
      taskId: ctx.currentTaskId || undefined,
      sessionId: ctx.currentSessionId || undefined,
      timestamp: new Date().toISOString(),
    });
  } catch {
    return unavailable('ipc_write_failed', '金融数据请求无法提交到宿主进程。');
  }

  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal.aborted) {
      return unavailable('request_aborted', '金融数据请求已取消。');
    }
    try {
      const raw = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as Record<
        string,
        unknown
      >;
      fs.unlinkSync(resultPath);
      if (!raw.success || !raw.result || typeof raw.result !== 'object') {
        return unavailable(
          typeof raw.code === 'string' ? raw.code : 'host_request_failed',
          typeof raw.error === 'string'
            ? raw.error
            : '宿主进程未返回金融数据。',
        );
      }
      return raw.result as FinanceToolResult;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return unavailable('ipc_read_failed', '金融数据回执无法读取。');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return unavailable('ipc_timeout', '宿主进程金融数据请求超时。');
}

export function createLongbridgeReadOnlyIpcCapability(
  ctx: FinanceIpcContext,
): LongbridgeReadOnlyCapability {
  return {
    getQuote: (input: FinanceSymbolQuery, signal) =>
      callFinanceIpc(ctx, 'get_quote', { ...input }, signal),
    getSecurity: (input: FinanceSymbolQuery, signal) =>
      callFinanceIpc(ctx, 'get_security', { ...input }, signal),
    getPositions: (input: FinancePositionsQuery, signal) =>
      callFinanceIpc(ctx, 'get_positions', { ...input }, signal),
    getHistoricalOrders: (input: FinanceHistoricalOrdersQuery, signal) =>
      callFinanceIpc(ctx, 'get_historical_orders', { ...input }, signal),
  };
}
