export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface MigrationFile {
  filename: string;
  /** Exact UTF-8 source, including BOM, comments and line endings. */
  sql: string;
  /** Exact sidecar text; parsed objects would change existing byte checksums. */
  checks_json?: string;
}
export interface RunRequest {
  command?: 'inspect' | 'status' | 'verify' | 'rehearse' | 'apply';
  db: string;
  dir?: string;
  /** Bundled migrations instead of dir; captured immediately, checksummed by the engine host. */
  migrations?: readonly MigrationFile[];
  /** Require this signed 32-bit PRAGMA application_id; never assigns it. */
  expected_application_id?: number;
  /** Require the current MoonMolt version (0 = empty history), checked under the transaction lock. */
  expected_version?: number;
  to?: number | null;
  rebuild?: boolean;
  create?: boolean;
  /** SQLite lock wait in milliseconds; default 5000. Zero fails immediately. */
  busy_timeout_ms?: number;
  /** Persistent backup destination for apply; default <db>.moonmolt-backups. */
  backup_dir?: string;
}
export interface HistoryEntry {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
  /** Decimal Int64 string, stored as INTEGER in SQLite. */
  duration_ms: string;
  schema_before: string;
  schema_after: string;
  tool_version: string;
}
export interface BatchResult {
  applied: HistoryEntry[];
  fingerprint: string;
  checks: { version: number; filename: string; name: string; ok: true }[];
  preserved: { version: number; filename: string; name: string; ok: true }[];
}
export interface ReportPaths {
  progress_warnings?: string[];
  stage?: 'prepare' | 'backup' | 'rehearse' | 'apply';
  backup?: string;
  incomplete_backup?: string;
  report_path?: string;
  report_warning?: string;
}
export type RunSuccess = ReportPaths & (
  | { ok: true; command: 'verify'; verified: true; database_modified: false; applied: HistoryEntry[]; pending: string[]; current_version: number; application_id: number; validation: { integrity_check: 'ok'; foreign_key_check: 'ok' } }
  | { ok: true; snapshot: { objects: Json[]; tables: Json[]; fingerprint: string; sqlite_version: string; application_id: number } }
  | { ok: true; command: 'status'; applied: HistoryEntry[]; pending: string[]; noop: boolean; current_version: number; application_id: number }
  | { ok: true; command: 'apply' | 'rehearse'; applied: HistoryEntry[]; pending: []; noop: true; current_version: number; application_id: number }
  | { ok: true; command: 'apply'; result: BatchResult; rehearsed: true; noop: false }
  | { ok: true; command: 'rehearse'; rehearsal: BatchResult; database_modified: false }
);
export interface Failure extends ReportPaths {
  ok: false;
  kind: 'input' | 'history_mismatch' | 'policy' | 'database' | 'lock_timeout' | 'commit_outcome_unknown' | 'runtime' | 'cleanup' | 'cancelled';
  exit_code: 1 | 2 | 3 | 4;
  message: string;
  cleanup_warnings?: string[];
  completed?: RunSuccess;
}
export type RunReport = RunSuccess | Failure;
/** Captures values and resolves relative paths immediately; owns queued connection lifecycle. */
export interface ProgressEvent {
  stage: 'prepare' | 'backup' | 'rehearse' | 'apply';
  operation: 'session' | 'load' | 'begin' | 'open_clone' | 'exec_script' | 'exec_check' | 'capture_value' | 'validate' | 'verify' | 'commit' | 'backup';
  state: 'start' | 'progress' | 'complete' | 'failed';
  sequence: number;
  timestamp: string;
  connection?: 'source' | 'clone';
  filename?: string;
  check_name?: string;
  phase?: 'before' | 'after';
  backup?: string;
  remaining_pages?: number;
  total_pages?: number;
  ok?: boolean;
}
export interface RunOptions {
  /** Cooperative cancellation before commit; does not interrupt an active SQLite call. */
  signal?: AbortSignal;
  /** Synchronous observer; callback failures become bounded report warnings. */
  onProgress?: (event: Readonly<ProgressEvent>) => void;
}
export function run(request: RunRequest, options?: RunOptions): Promise<RunReport>;
/** One worker per call, with the same SQLite locks and migration policy. */
export function runInWorker(request: RunRequest, options?: RunOptions): Promise<RunReport>;

export interface SchemaColumn {
  name: string;
  data_type: 'INTEGER' | 'TEXT' | 'REAL' | 'BLOB' | 'NUMERIC';
  nullable: boolean;
  primary_key: boolean;
  unique: boolean;
  default_value?: string | null;
}
export interface SchemaTable {
  name: string;
  columns: SchemaColumn[];
  indexes: { name: string; columns: string[]; unique: boolean }[];
  foreign_keys: { name: string; columns: string[]; referenced_table: string; referenced_columns: string[]; on_delete?: string | null; on_update?: string | null }[];
  checks: [];
  triggers: [];
}
export interface SchemaModel { version: string; tables: SchemaTable[]; views: [] }
export interface PlanRequest {
  before: SchemaModel;
  after: SchemaModel;
  hints?: { tables: [string, string][]; columns: [string, string, string][] };
  allow_destructive?: boolean;
}
export type PlanReport = Failure | { ok: true; sql: string; requires_rebuild: boolean; plan: Json };
/** Pure synchronous planning; SQL is a draft for review and versioning. */
export function plan(request: PlanRequest): PlanReport;
