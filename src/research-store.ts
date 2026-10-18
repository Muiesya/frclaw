import crypto from 'node:crypto';
import Database from './sqlite-compat.js';
import {
  ageSeconds,
  isResearchEvidenceStale,
  retrievalLatencySeconds,
  type ResearchCapabilityId,
  type ResearchEvidenceRef,
  type ResearchPlan,
  type ResearchReport,
  type ResearchRunStatus,
  type ResearchStepStatus,
} from './research-model.js';

type ResearchDatabase = InstanceType<typeof Database>;

export interface ResearchRun {
  id: string;
  userId: string;
  symbol: string;
  question: string;
  status: ResearchRunStatus;
  plan: ResearchPlan;
  report: ResearchReport | null;
  idempotencyKey: string | null;
  attempt: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseToken: number;
  leaseExpiresAt: string | null;
  startedAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ResearchStep {
  id: string;
  runId: string;
  capability: ResearchCapabilityId;
  provider: string;
  status: ResearchStepStatus;
  parameters: Record<string, unknown>;
  dependsOn: ResearchCapabilityId[];
  timeoutMs: number;
  maxAttempts: number;
  attempt: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseToken: number;
  leaseExpiresAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number;
  errorCode: string | null;
  errorKind: string | null;
  errorMessage: string | null;
  result: Record<string, unknown> | null;
}

export interface ResearchAuditEvent {
  id: string;
  sequence: number;
  runId: string;
  userId: string;
  eventType: string;
  attempt: number;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ClaimedResearchRun extends ResearchRun {
  leaseOwner: string;
  leaseExpiresAt: string;
}

export interface ResearchEvidenceInput {
  symbol: string;
  market?: string;
  entity?: string;
  period?: string;
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
  retrievalLatencySeconds?: number | null;
  maxAgeSeconds?: number | null;
  /** @deprecated Use retrievalLatencySeconds. */
  freshnessSeconds?: number | null;
  value: unknown;
  unit?: string;
}

let db: ResearchDatabase;
let researchAuditEventListener:
  | ((event: ResearchAuditEvent) => void)
  | undefined;

export function setResearchAuditEventListener(
  listener: ((event: ResearchAuditEvent) => void) | undefined,
): void {
  researchAuditEventListener = listener;
}

function now(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`;
}

function evidenceFingerprint(input: ResearchEvidenceInput): string {
  return crypto
    .createHash('sha256')
    .update(
      stableJson({
        symbol: input.symbol,
        market: input.market ?? null,
        entity: input.entity ?? null,
        period: input.period ?? null,
        metric: input.metric,
        sourceId: input.sourceId,
        sourceKind: input.sourceKind,
        contentTrust: input.contentTrust ?? null,
        asOf: input.asOf,
        retrievedAt: input.retrievedAt,
        value: input.value,
      }),
    )
    .digest('hex');
}

function canonicalIdempotencyKey(input: {
  key: string;
  symbol: string;
  question: string;
  plan: ResearchPlan;
}): string {
  const fingerprint = crypto
    .createHash('sha256')
    .update(
      stableJson({
        symbol: input.symbol,
        question: input.question,
        planVersion: input.plan.version,
        capabilities: input.plan.capabilities,
      }),
    )
    .digest('hex');
  return `${input.key.trim()}:${fingerprint}`;
}

function ensureColumn(
  database: ResearchDatabase,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = database
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function createResearchSchema(database: ResearchDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS research_runs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      question TEXT NOT NULL,
      status TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      report_json TEXT,
      idempotency_key TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL DEFAULT '',
      lease_owner TEXT,
      lease_token INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,
      started_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_research_runs_user_updated
      ON research_runs(user_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS research_steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      parameters_json TEXT NOT NULL,
      depends_on_json TEXT NOT NULL DEFAULT '[]',
      timeout_ms INTEGER NOT NULL DEFAULT 10000,
      max_attempts INTEGER NOT NULL DEFAULT 1,
      attempt INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL DEFAULT '',
      lease_owner TEXT,
      lease_token INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_kind TEXT,
      error_message TEXT,
      result_json TEXT,
      FOREIGN KEY (run_id) REFERENCES research_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_research_steps_run
      ON research_steps(run_id, capability);
    CREATE TABLE IF NOT EXISTS research_evidence (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      fingerprint TEXT NOT NULL DEFAULT '',
      is_current INTEGER NOT NULL DEFAULT 1,
      symbol TEXT NOT NULL,
      market TEXT,
      entity TEXT,
      period TEXT,
      metric TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      content_trust TEXT,
      as_of TEXT,
      retrieved_at TEXT NOT NULL,
      freshness_seconds INTEGER,
      retrieval_latency_seconds INTEGER,
      max_age_seconds INTEGER,
      unit TEXT,
      value_json TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES research_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (step_id) REFERENCES research_steps(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_research_evidence_run_legacy
      ON research_evidence(run_id, retrieved_at);
  `);

  // v70 databases already have the three tables. Keep this additive migration
  // here so upgrades do not require rebuilding user research history.
  const runColumns: Array<[string, string]> = [
    ['idempotency_key', 'TEXT'],
    ['attempt', 'INTEGER NOT NULL DEFAULT 0'],
    ['available_at', "TEXT NOT NULL DEFAULT ''"],
    ['lease_owner', 'TEXT'],
    ['lease_token', 'INTEGER NOT NULL DEFAULT 0'],
    ['lease_expires_at', 'TEXT'],
    ['started_at', 'TEXT'],
  ];
  for (const [column, definition] of runColumns) {
    ensureColumn(database, 'research_runs', column, definition);
  }
  const stepColumns: Array<[string, string]> = [
    ['depends_on_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['timeout_ms', 'INTEGER NOT NULL DEFAULT 10000'],
    ['max_attempts', 'INTEGER NOT NULL DEFAULT 1'],
    ['available_at', "TEXT NOT NULL DEFAULT ''"],
    ['lease_owner', 'TEXT'],
    ['lease_token', 'INTEGER NOT NULL DEFAULT 0'],
    ['lease_expires_at', 'TEXT'],
    ['duration_ms', 'INTEGER NOT NULL DEFAULT 0'],
    ['error_kind', 'TEXT'],
  ];
  for (const [column, definition] of stepColumns) {
    ensureColumn(database, 'research_steps', column, definition);
  }
  const evidenceColumns: Array<[string, string]> = [
    ['market', 'TEXT'],
    ['entity', 'TEXT'],
    ['period', 'TEXT'],
    ['content_trust', 'TEXT'],
    ['unit', 'TEXT'],
    ['attempt', 'INTEGER NOT NULL DEFAULT 0'],
    ['fingerprint', "TEXT NOT NULL DEFAULT ''"],
    ['is_current', 'INTEGER NOT NULL DEFAULT 1'],
    ['retrieval_latency_seconds', 'INTEGER'],
    ['max_age_seconds', 'INTEGER'],
  ];
  for (const [column, definition] of evidenceColumns) {
    ensureColumn(database, 'research_evidence', column, definition);
  }
  const timestamp = now();
  database
    .prepare(
      "UPDATE research_runs SET available_at = ? WHERE available_at = ''",
    )
    .run(timestamp);
  database
    .prepare(
      "UPDATE research_steps SET available_at = ? WHERE available_at = ''",
    )
    .run(timestamp);
  const legacyEvidence = database
    .prepare(
      "SELECT id, fingerprint FROM research_evidence WHERE fingerprint = '' OR fingerprint IS NULL",
    )
    .all() as Array<{ id: string; fingerprint: string | null }>;
  const backfillEvidenceFingerprint = database.prepare(
    'UPDATE research_evidence SET fingerprint = ? WHERE id = ?',
  );
  for (const row of legacyEvidence) {
    backfillEvidenceFingerprint.run(
      crypto.createHash('sha256').update(`legacy:${row.id}`).digest('hex'),
      row.id,
    );
  }
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_research_runs_user_idempotency
      ON research_runs(user_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_research_runs_queue
      ON research_runs(status, available_at, lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_research_steps_queue
      ON research_steps(status, available_at, lease_expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_research_evidence_attempt_fingerprint
      ON research_evidence(step_id, attempt, fingerprint);
    CREATE TABLE IF NOT EXISTS research_audit_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES research_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_research_audit_run
      ON research_audit_events(run_id, created_at);
  `);
}

export function bindResearchDatabase(database: ResearchDatabase): void {
  db = database;
}

function requireDb(): ResearchDatabase {
  if (!db) throw new Error('Research database has not been bound');
  return db;
}

export interface ResearchRunSummary {
  id: string;
  userId: string;
  symbol: string;
  question: string;
  status: ResearchRunStatus;
  attempt: number;
  startedAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

function mapRunSummary(row: any): ResearchRunSummary {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    symbol: String(row.symbol),
    question: String(row.question),
    status: row.status as ResearchRunStatus,
    attempt: Number(row.attempt ?? 0),
    startedAt: row.started_at ? String(row.started_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
  };
}

function mapRun(row: any): ResearchRun {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    symbol: String(row.symbol),
    question: String(row.question),
    status: row.status as ResearchRunStatus,
    plan: parseJson<ResearchPlan>(row.plan_json, {
      version: 1,
      generatedAt: row.created_at,
      capabilities: [],
    }),
    report: row.report_json
      ? parseJson<ResearchReport | null>(row.report_json, null)
      : null,
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : null,
    attempt: Number(row.attempt ?? 0),
    availableAt: String(row.available_at || row.created_at),
    leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
    leaseToken: Number(row.lease_token ?? 0),
    leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null,
    startedAt: row.started_at ? String(row.started_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
  };
}

function mapStep(row: any): ResearchStep {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    capability: row.capability as ResearchCapabilityId,
    provider: String(row.provider),
    status: row.status as ResearchStepStatus,
    parameters: parseJson<Record<string, unknown>>(row.parameters_json, {}),
    dependsOn: parseJson<ResearchCapabilityId[]>(row.depends_on_json, []),
    timeoutMs: Number(row.timeout_ms ?? 10000),
    maxAttempts: Number(row.max_attempts ?? 1),
    attempt: Number(row.attempt ?? 0),
    availableAt: String(row.available_at || row.started_at || now()),
    leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
    leaseToken: Number(row.lease_token ?? 0),
    leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null,
    startedAt: row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    durationMs: Number(row.duration_ms ?? 0),
    errorCode: row.error_code ? String(row.error_code) : null,
    errorKind: row.error_kind ? String(row.error_kind) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    result: row.result_json
      ? parseJson<Record<string, unknown> | null>(row.result_json, null)
      : null,
  };
}

function mapEvidence(row: any): ResearchEvidenceRef {
  return {
    id: String(row.id),
    stepId: String(row.step_id),
    symbol: String(row.symbol),
    market: row.market ? String(row.market) : undefined,
    entity: row.entity ? String(row.entity) : undefined,
    period: row.period ? String(row.period) : undefined,
    metric: String(row.metric),
    sourceId: String(row.source_id),
    sourceKind: String(row.source_kind),
    asOf: row.as_of ? String(row.as_of) : null,
    retrievedAt: String(row.retrieved_at),
    retrievalLatencySeconds:
      row.retrieval_latency_seconds === null ||
      row.retrieval_latency_seconds === undefined
        ? row.freshness_seconds === null || row.freshness_seconds === undefined
          ? retrievalLatencySeconds(
              row.as_of ? String(row.as_of) : null,
              String(row.retrieved_at),
            )
          : Number(row.freshness_seconds)
        : Number(row.retrieval_latency_seconds),
    ageSeconds: ageSeconds(row.as_of ? String(row.as_of) : null),
    maxAgeSeconds:
      row.max_age_seconds === null || row.max_age_seconds === undefined
        ? null
        : Number(row.max_age_seconds),
    isStale: isResearchEvidenceStale(
      row.as_of ? String(row.as_of) : null,
      row.max_age_seconds === null || row.max_age_seconds === undefined
        ? null
        : Number(row.max_age_seconds),
    ),
    // Compatibility alias for older clients; new UI must use the explicit name.
    freshnessSeconds:
      row.retrieval_latency_seconds === null ||
      row.retrieval_latency_seconds === undefined
        ? row.freshness_seconds === null || row.freshness_seconds === undefined
          ? null
          : Number(row.freshness_seconds)
        : Number(row.retrieval_latency_seconds),
    value: parseJson<unknown>(row.value_json, null),
    unit: row.unit ? String(row.unit) : undefined,
    contentTrust: row.content_trust
      ? (String(row.content_trust) as ResearchEvidenceRef['contentTrust'])
      : undefined,
    attempt: Number(row.attempt ?? 0),
    fingerprint: row.fingerprint ? String(row.fingerprint) : undefined,
    isCurrent: Number(row.is_current ?? 1) === 1,
  };
}

export function createResearchRun(input: {
  userId: string;
  symbol: string;
  question: string;
  plan: ResearchPlan;
  idempotencyKey?: string | null;
}): ResearchRun {
  const database = requireDb();
  const timestamp = now();
  const idempotencyKey = input.idempotencyKey?.trim()
    ? canonicalIdempotencyKey({
        key: input.idempotencyKey,
        symbol: input.symbol,
        question: input.question,
        plan: input.plan,
      })
    : null;
  if (idempotencyKey) {
    const existing = getResearchRunByIdempotency(input.userId, idempotencyKey);
    if (existing) return existing;
  }
  const runId = id('research');
  const steps = input.plan.capabilities.map((step) => ({
    id: id('research_step'),
    ...step,
  }));
  const transaction = database.transaction(() => {
    database
      .prepare(
        `INSERT INTO research_runs
          (id, user_id, symbol, question, status, plan_json, report_json,
           idempotency_key, available_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        input.userId,
        input.symbol,
        input.question,
        JSON.stringify(input.plan),
        idempotencyKey,
        timestamp,
        timestamp,
        timestamp,
      );
    const insertStep = database.prepare(
      `INSERT INTO research_steps
        (id, run_id, capability, provider, status, parameters_json,
         depends_on_json, timeout_ms, max_attempts, available_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
    );
    for (const step of steps) {
      insertStep.run(
        step.id,
        runId,
        step.capability,
        step.provider,
        JSON.stringify({ ...(step.parameters ?? {}), symbol: input.symbol }),
        JSON.stringify(step.dependsOn ?? []),
        step.timeoutMs ?? 10_000,
        step.maxAttempts ?? 1,
        timestamp,
      );
    }
  });
  try {
    transaction();
  } catch (error) {
    if (idempotencyKey) {
      const existing = getResearchRunByIdempotency(
        input.userId,
        idempotencyKey,
      );
      if (existing) return existing;
    }
    throw error;
  }
  const created = getResearchRunForUser(runId, input.userId)!;
  recordResearchAuditEvent({
    runId,
    eventType: 'run_created',
    attempt: 0,
    details: { symbol: input.symbol, question: input.question },
  });
  recordResearchAuditEvent({
    runId,
    eventType: 'run_queued',
    attempt: 0,
    details: { reason: 'created' },
  });
  return created;
}

export function recordResearchAuditEvent(input: {
  runId: string;
  eventType: string;
  attempt?: number;
  details?: Record<string, unknown>;
}): void {
  const run = getResearchRun(input.runId);
  if (!run) return;
  const eventId = id('research_audit');
  const createdAt = now();
  const database = requireDb();
  database
    .prepare(
      `INSERT INTO research_audit_events
       (id, run_id, user_id, event_type, attempt, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      eventId,
      run.id,
      run.userId,
      input.eventType,
      input.attempt ?? run.attempt,
      JSON.stringify(input.details ?? {}),
      createdAt,
    );
  const event = database
    .prepare(
      'SELECT rowid AS sequence, * FROM research_audit_events WHERE id = ?',
    )
    .get(eventId) as any;
  researchAuditEventListener?.({
    id: String(event.id),
    sequence: Number(event.sequence),
    runId: String(event.run_id),
    userId: String(event.user_id),
    eventType: String(event.event_type),
    attempt: Number(event.attempt ?? 0),
    details: parseJson<Record<string, unknown>>(event.details_json, {}),
    createdAt: String(event.created_at),
  });
}

export function listResearchAuditEvents(runId: string): ResearchAuditEvent[] {
  return requireDb()
    .prepare(
      `SELECT rowid AS sequence, * FROM research_audit_events WHERE run_id = ?
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(runId)
    .map((row: any) => ({
      id: String(row.id),
      sequence: Number(row.sequence ?? row.rowid ?? 0),
      runId: String(row.run_id),
      userId: String(row.user_id),
      eventType: String(row.event_type),
      attempt: Number(row.attempt ?? 0),
      details: parseJson<Record<string, unknown>>(row.details_json, {}),
      createdAt: String(row.created_at),
    }));
}

export function getResearchRunByIdempotency(
  userId: string,
  idempotencyKey: string,
): ResearchRun | undefined {
  const row = requireDb()
    .prepare(
      'SELECT * FROM research_runs WHERE user_id = ? AND idempotency_key = ?',
    )
    .get(userId, idempotencyKey);
  return row ? mapRun(row) : undefined;
}

export function enqueueResearchRun(runId: string): boolean {
  const timestamp = now();
  const result = requireDb()
    .prepare(
      `UPDATE research_runs SET status = 'queued', available_at = ?,
       completed_at = NULL, updated_at = ?
       WHERE id = ? AND status IN ('planned','retry_wait','uncertain')`,
    )
    .run(timestamp, timestamp, runId);
  requireDb()
    .prepare(
      `UPDATE research_steps SET status = CASE WHEN status IN
       ('planned','retry_wait','uncertain','manual_reconciliation') THEN 'queued' ELSE status END,
       available_at = ?, lease_owner = NULL, lease_expires_at = NULL
       WHERE run_id = ? AND status IN
       ('planned','retry_wait','uncertain','manual_reconciliation')`,
    )
    .run(timestamp, runId);
  if (result.changes === 1) {
    recordResearchAuditEvent({
      runId,
      eventType: 'run_queued',
      details: { reason: 'resume_or_recovery' },
    });
  }
  return result.changes === 1;
}

export function recoverResearchRunsOnStartup(): number {
  const timestamp = now();
  return requireDb().transaction(() => {
    const interrupted = requireDb()
      .prepare("SELECT id FROM research_runs WHERE status = 'running'")
      .all() as Array<{ id: string }>;
    const uncertain = requireDb()
      .prepare(
        `UPDATE research_runs SET status = 'uncertain', lease_owner = NULL,
         lease_expires_at = NULL, updated_at = ?
         WHERE status = 'running'`,
      )
      .run(timestamp).changes;
    for (const run of interrupted) {
      recordResearchAuditEvent({
        runId: String(run.id),
        eventType: 'run_recovered',
        details: { reason: 'process_restart', status: 'uncertain' },
      });
    }
    requireDb()
      .prepare(
        `UPDATE research_steps SET status = 'uncertain', lease_owner = NULL,
         lease_expires_at = NULL, error_code = COALESCE(error_code, 'process_interrupted'),
         error_kind = COALESCE(error_kind, 'unknown'),
         error_message = COALESCE(error_message, '服务重启时无法确认 Provider 调用结果。')
         WHERE status = 'running'`,
      )
      .run();
    requireDb()
      .prepare(
        `UPDATE research_runs SET status = 'queued', available_at = ?, updated_at = ?
         WHERE status = 'planned'`,
      )
      .run(timestamp, timestamp);
    requireDb()
      .prepare(
        `UPDATE research_steps SET status = 'queued', available_at = ?
         WHERE status = 'planned'`,
      )
      .run(timestamp);
    return uncertain;
  })();
}

function claimResearchRunRow(
  runId: string | null,
  owner: string,
  leaseMs: number,
): ClaimedResearchRun | undefined {
  const database = requireDb();
  const nowDate = new Date();
  const timestamp = nowDate.toISOString();
  const expires = new Date(nowDate.getTime() + leaseMs).toISOString();
  return database.transaction(() => {
    const candidate = database
      .prepare(
        `SELECT * FROM research_runs
         WHERE status IN ('queued','retry_wait') AND available_at <= ?
           ${runId ? 'AND id = ?' : ''}
         ORDER BY available_at, created_at LIMIT 1`,
      )
      .get(...(runId ? [timestamp, runId] : [timestamp])) as any;
    if (!candidate) return undefined;
    const token = Number(candidate.lease_token ?? 0) + 1;
    const result = database
      .prepare(
        `UPDATE research_runs SET status = 'running', lease_owner = ?,
         lease_token = ?, lease_expires_at = ?, attempt = attempt + 1,
         started_at = COALESCE(started_at, ?), updated_at = ?
         WHERE id = ? AND status IN ('queued','retry_wait') AND available_at <= ?`,
      )
      .run(
        owner,
        token,
        expires,
        timestamp,
        timestamp,
        candidate.id,
        timestamp,
      );
    if (result.changes !== 1) return undefined;
    return mapRun(
      database
        .prepare('SELECT * FROM research_runs WHERE id = ?')
        .get(candidate.id),
    ) as ClaimedResearchRun;
  })();
}

export function claimNextResearchRun(
  owner: string,
  leaseMs: number,
): ClaimedResearchRun | undefined {
  return claimResearchRunRow(null, owner, leaseMs);
}

export function claimResearchRun(
  runId: string,
  owner: string,
  leaseMs: number,
): ClaimedResearchRun | undefined {
  return claimResearchRunRow(runId, owner, leaseMs);
}

export function renewResearchRunLease(
  runId: string,
  owner: string,
  token: number,
  leaseMs: number,
): boolean {
  const nowDate = new Date();
  const result = requireDb()
    .prepare(
      `UPDATE research_runs SET lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_token = ?`,
    )
    .run(
      new Date(nowDate.getTime() + leaseMs).toISOString(),
      nowDate.toISOString(),
      runId,
      owner,
      token,
    );
  return result.changes === 1;
}

export function isResearchRunLeaseOwned(
  runId: string,
  owner: string,
  token: number,
): boolean {
  return Boolean(
    requireDb()
      .prepare(
        `SELECT 1 FROM research_runs WHERE id = ? AND status = 'running'
         AND lease_owner = ? AND lease_token = ?`,
      )
      .get(runId, owner, token),
  );
}

export function cancelResearchRunDurable(runId: string): boolean {
  const timestamp = now();
  const result = requireDb()
    .prepare(
      `UPDATE research_runs SET status = 'cancelled', completed_at = ?,
       lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND status IN
       ('planned','queued','retry_wait','running','uncertain','manual_reconciliation')`,
    )
    .run(timestamp, timestamp, runId);
  requireDb()
    .prepare(
      `UPDATE research_steps SET status = 'cancelled', completed_at = ?,
       lease_owner = NULL, lease_expires_at = NULL, error_code = 'cancelled',
       error_kind = 'cancelled', error_message = '用户取消了研究运行。'
       WHERE run_id = ? AND status IN
       ('planned','queued','retry_wait','running','uncertain','manual_reconciliation')`,
    )
    .run(timestamp, runId);
  if (result.changes === 1) {
    recordResearchAuditEvent({
      runId,
      eventType: 'run_cancelled',
      details: { reason: 'user_request' },
    });
  }
  return result.changes === 1;
}

export function releaseResearchRunForRetry(
  runId: string,
  owner: string,
  token: number,
  availableAt: string,
  error: string,
): boolean {
  const result = requireDb()
    .prepare(
      `UPDATE research_runs SET status = 'retry_wait', available_at = ?,
       lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_token = ?`,
    )
    .run(availableAt, now(), runId, owner, token);
  return result.changes === 1;
}

export function markResearchRunUncertain(
  runId: string,
  owner: string,
  token: number,
  status: 'uncertain' | 'manual_reconciliation',
): boolean {
  const result = requireDb()
    .prepare(
      `UPDATE research_runs SET status = ?, report_json = NULL,
       completed_at = NULL, lease_owner = NULL, lease_expires_at = NULL,
       updated_at = ?
       WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_token = ?`,
    )
    .run(status, now(), runId, owner, token);
  return result.changes === 1;
}

export function completeResearchRun(
  runId: string,
  owner: string,
  token: number,
  status: ResearchRunStatus,
  report: ResearchReport | null,
): boolean {
  const timestamp = now();
  const result = requireDb()
    .prepare(
      `UPDATE research_runs SET status = ?, report_json = ?, completed_at = ?,
       lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_token = ?`,
    )
    .run(
      status,
      report ? JSON.stringify(report) : null,
      timestamp,
      timestamp,
      runId,
      owner,
      token,
    );
  return result.changes === 1;
}

export function getResearchRunForUser(
  runId: string,
  userId: string,
): ResearchRun | undefined {
  const row = requireDb()
    .prepare('SELECT * FROM research_runs WHERE id = ? AND user_id = ?')
    .get(runId, userId);
  return row ? mapRun(row) : undefined;
}

export function getResearchRun(runId: string): ResearchRun | undefined {
  const row = requireDb()
    .prepare('SELECT * FROM research_runs WHERE id = ?')
    .get(runId);
  return row ? mapRun(row) : undefined;
}

export function listResearchRuns(
  userId: string,
  limit = 30,
): ResearchRunSummary[] {
  const rows = requireDb()
    .prepare(
      `SELECT id, user_id, symbol, question, status, attempt, started_at,
              created_at, updated_at, completed_at
       FROM research_runs
       WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(userId, Math.min(Math.max(limit, 1), 100));
  return rows.map(mapRunSummary);
}

export function updateResearchRun(
  runId: string,
  patch: {
    status?: ResearchRunStatus;
    report?: ResearchReport | null;
    completedAt?: string | null;
  },
): void {
  const timestamp = now();
  requireDb()
    .prepare(
      `UPDATE research_runs SET
        status = COALESCE(?, status),
        report_json = CASE WHEN ? THEN ? ELSE report_json END,
        completed_at = CASE WHEN ? THEN ? ELSE completed_at END,
        updated_at = ?
       WHERE id = ?`,
    )
    .run(
      patch.status ?? null,
      patch.report !== undefined ? 1 : 0,
      patch.report === undefined ? null : JSON.stringify(patch.report),
      patch.completedAt !== undefined ? 1 : 0,
      patch.completedAt ?? null,
      timestamp,
      runId,
    );
}

export function listResearchSteps(runId: string): ResearchStep[] {
  return requireDb()
    .prepare('SELECT * FROM research_steps WHERE run_id = ? ORDER BY rowid ASC')
    .all(runId)
    .map(mapStep);
}

export function updateResearchStep(
  stepId: string,
  patch: {
    status?: ResearchStepStatus;
    attempt?: number;
    startedAt?: string | null;
    completedAt?: string | null;
    errorCode?: string | null;
    errorKind?: string | null;
    errorMessage?: string | null;
    result?: Record<string, unknown> | null;
  },
): void {
  const existing = requireDb()
    .prepare('SELECT * FROM research_steps WHERE id = ?')
    .get(stepId);
  if (!existing) return;
  requireDb()
    .prepare(
      `UPDATE research_steps SET
        status = COALESCE(?, status), attempt = COALESCE(?, attempt),
        started_at = CASE WHEN ? THEN ? ELSE started_at END,
        completed_at = CASE WHEN ? THEN ? ELSE completed_at END,
        error_code = CASE WHEN ? THEN ? ELSE error_code END,
        error_kind = CASE WHEN ? THEN ? ELSE error_kind END,
        error_message = CASE WHEN ? THEN ? ELSE error_message END,
        result_json = CASE WHEN ? THEN ? ELSE result_json END,
        updated_at = updated_at
       WHERE id = ?`,
    )
    .run(
      patch.status ?? null,
      patch.attempt ?? null,
      patch.startedAt !== undefined ? 1 : 0,
      patch.startedAt ?? null,
      patch.completedAt !== undefined ? 1 : 0,
      patch.completedAt ?? null,
      patch.errorCode !== undefined ? 1 : 0,
      patch.errorCode ?? null,
      patch.errorKind !== undefined ? 1 : 0,
      patch.errorKind ?? null,
      patch.errorMessage !== undefined ? 1 : 0,
      patch.errorMessage ?? null,
      patch.result !== undefined ? 1 : 0,
      patch.result === undefined ? null : JSON.stringify(patch.result),
      stepId,
    );
}

export function startResearchStep(
  runId: string,
  stepId: string,
  owner: string,
  runToken: number,
  leaseMs: number,
): { attempt: number; parameters: Record<string, unknown> } | undefined {
  const database = requireDb();
  const timestamp = now();
  const expires = new Date(Date.now() + leaseMs).toISOString();
  return database.transaction(() => {
    const row = database
      .prepare(
        `SELECT s.* FROM research_steps s JOIN research_runs r ON r.id = s.run_id
         WHERE s.id = ? AND s.run_id = ? AND r.lease_owner = ? AND r.lease_token = ?
           AND s.status IN ('queued','planned','retry_wait')`,
      )
      .get(stepId, runId, owner, runToken) as any;
    if (!row) return undefined;
    const attempt = Number(row.attempt ?? 0) + 1;
    const result = database
      .prepare(
        `UPDATE research_steps SET status = 'running', attempt = ?, started_at = ?,
         completed_at = NULL, duration_ms = 0, lease_owner = ?, lease_token = ?,
         lease_expires_at = ?, error_code = NULL, error_kind = NULL, error_message = NULL
         WHERE id = ? AND run_id = ? AND status IN ('queued','planned','retry_wait')`,
      )
      .run(attempt, timestamp, owner, runToken, expires, stepId, runId);
    return result.changes === 1
      ? {
          attempt,
          parameters: parseJson<Record<string, unknown>>(
            row.parameters_json,
            {},
          ),
        }
      : undefined;
  })();
}

export function renewResearchStepLease(
  stepId: string,
  owner: string,
  token: number,
  leaseMs: number,
): boolean {
  const timestamp = new Date();
  return (
    requireDb()
      .prepare(
        `UPDATE research_steps SET lease_expires_at = ?
       WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_token = ?`,
      )
      .run(
        new Date(timestamp.getTime() + leaseMs).toISOString(),
        stepId,
        owner,
        token,
      ).changes === 1
  );
}

export function commitResearchStepResult(input: {
  runId: string;
  stepId: string;
  owner: string;
  runToken: number;
  stepAttempt: number;
  parameters: Record<string, unknown>;
  status: ResearchStepStatus;
  result: Record<string, unknown>;
  evidence: ResearchEvidenceInput[];
  errorCode?: string | null;
  errorKind?: string | null;
  errorMessage?: string | null;
}): boolean {
  const database = requireDb();
  const completedAt = now();
  return database.transaction(() => {
    const row = database
      .prepare(
        `SELECT s.parameters_json, s.started_at FROM research_steps s
         JOIN research_runs r ON r.id = s.run_id
         WHERE s.id = ? AND s.run_id = ? AND s.status = 'running'
           AND s.attempt = ? AND s.lease_owner = ? AND s.lease_token = ?
           AND r.lease_owner = ? AND r.lease_token = ?`,
      )
      .get(
        input.stepId,
        input.runId,
        input.stepAttempt,
        input.owner,
        input.runToken,
        input.owner,
        input.runToken,
      ) as any;
    if (
      !row ||
      stableJson(
        parseJson<Record<string, unknown>>(row.parameters_json, {}),
      ) !== stableJson(input.parameters)
    )
      return false;
    for (const evidence of input.evidence) {
      const fingerprint = evidenceFingerprint(evidence);
      const evidenceId = `evidence_${input.runId}_${input.stepId}_${input.stepAttempt}_${fingerprint}`;
      const latency =
        evidence.retrievalLatencySeconds ??
        evidence.freshnessSeconds ??
        retrievalLatencySeconds(evidence.asOf, evidence.retrievedAt);
      database
        .prepare(
          `INSERT OR IGNORE INTO research_evidence
           (id, run_id, step_id, attempt, fingerprint, is_current, symbol,
            market, entity, period, metric, source_id, source_kind,
            content_trust, as_of, retrieved_at, freshness_seconds,
            retrieval_latency_seconds, max_age_seconds, unit, value_json)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          evidenceId,
          input.runId,
          input.stepId,
          input.stepAttempt,
          fingerprint,
          evidence.symbol,
          evidence.market ?? null,
          evidence.entity ?? null,
          evidence.period ?? null,
          evidence.metric,
          evidence.sourceId,
          evidence.sourceKind,
          evidence.contentTrust ?? null,
          evidence.asOf,
          evidence.retrievedAt,
          latency,
          latency,
          evidence.maxAgeSeconds ?? null,
          evidence.unit ?? null,
          JSON.stringify(evidence.value),
        );
    }
    // Do not hide a known-good result when a retry has no evidence. Only a
    // non-empty result creates a new current generation for this step.
    if (input.evidence.length > 0) {
      database
        .prepare(
          'UPDATE research_evidence SET is_current = 0 WHERE step_id = ?',
        )
        .run(input.stepId);
      database
        .prepare(
          'UPDATE research_evidence SET is_current = 1 WHERE step_id = ? AND attempt = ?',
        )
        .run(input.stepId, input.stepAttempt);
    }
    const started = row.started_at ? Date.parse(row.started_at) : Date.now();
    const result = database
      .prepare(
        `UPDATE research_steps SET status = ?, completed_at = ?, duration_ms = ?,
         error_code = ?, error_kind = ?, error_message = ?, result_json = ?,
         lease_owner = NULL, lease_expires_at = NULL
         WHERE id = ? AND status = 'running' AND attempt = ? AND lease_owner = ?
           AND lease_token = ?`,
      )
      .run(
        input.status,
        completedAt,
        Math.max(0, Date.now() - started),
        input.errorCode ?? null,
        input.errorKind ?? null,
        input.errorMessage ?? null,
        JSON.stringify(input.result),
        input.stepId,
        input.stepAttempt,
        input.owner,
        input.runToken,
      );
    return result.changes === 1;
  })();
}

export function failResearchStep(input: {
  runId: string;
  stepId: string;
  owner: string;
  runToken: number;
  stepAttempt: number;
  status: ResearchStepStatus;
  errorCode: string;
  errorKind: string;
  errorMessage: string;
}): boolean {
  return commitResearchStepResult({
    ...input,
    parameters: (() => {
      const step = requireDb()
        .prepare('SELECT parameters_json FROM research_steps WHERE id = ?')
        .get(input.stepId) as any;
      return parseJson<Record<string, unknown>>(step?.parameters_json, {});
    })(),
    result: {},
    evidence: [],
  });
}

export function resetIncompleteResearchSteps(runId: string): void {
  const timestamp = now();
  requireDb()
    .prepare(
      `UPDATE research_steps SET status = 'queued', available_at = ?,
       lease_owner = NULL, lease_expires_at = NULL, completed_at = NULL,
       error_code = NULL, error_kind = NULL, error_message = NULL
       WHERE run_id = ? AND status != 'completed'`,
    )
    .run(timestamp, runId);
}

export function addResearchEvidence(input: {
  runId: string;
  stepId: string;
  symbol: string;
  market?: string;
  entity?: string;
  period?: string;
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
  retrievalLatencySeconds?: number | null;
  maxAgeSeconds?: number | null;
  /** @deprecated Use retrievalLatencySeconds. */
  freshnessSeconds?: number | null;
  value: unknown;
  unit?: string;
  attempt?: number;
}): string {
  const evidence: ResearchEvidenceInput = input;
  const fingerprint = evidenceFingerprint(evidence);
  const evidenceId = `evidence_${input.runId}_${input.stepId}_${input.attempt ?? 0}_${fingerprint}`;
  const database = requireDb();
  const write = database.transaction(() => {
    database
      .prepare('UPDATE research_evidence SET is_current = 0 WHERE step_id = ?')
      .run(input.stepId);
    database
      .prepare(
        `INSERT OR IGNORE INTO research_evidence
       (id, run_id, step_id, attempt, fingerprint, is_current, symbol,
        market, entity, period, metric, source_id, source_kind,
        content_trust, as_of, retrieved_at, freshness_seconds,
        retrieval_latency_seconds, max_age_seconds, unit, value_json)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        evidenceId,
        input.runId,
        input.stepId,
        input.attempt ?? 0,
        fingerprint,
        input.symbol,
        input.market ?? null,
        input.entity ?? null,
        input.period ?? null,
        input.metric,
        input.sourceId,
        input.sourceKind,
        input.contentTrust ?? null,
        input.asOf,
        input.retrievedAt,
        input.retrievalLatencySeconds ??
          input.freshnessSeconds ??
          retrievalLatencySeconds(input.asOf, input.retrievedAt),
        input.retrievalLatencySeconds ??
          input.freshnessSeconds ??
          retrievalLatencySeconds(input.asOf, input.retrievedAt),
        input.maxAgeSeconds ?? null,
        input.unit ?? null,
        JSON.stringify(input.value),
      );
    database
      .prepare('UPDATE research_evidence SET is_current = 1 WHERE id = ?')
      .run(evidenceId);
  });
  write();
  return evidenceId;
}

export function listResearchEvidence(
  runId: string,
  options: { includeHistory?: boolean } = {},
): ResearchEvidenceRef[] {
  return requireDb()
    .prepare(
      `SELECT * FROM research_evidence WHERE run_id = ?
       ${options.includeHistory ? '' : 'AND is_current = 1'}
       ORDER BY retrieved_at ASC, rowid ASC`,
    )
    .all(runId)
    .map(mapEvidence);
}
