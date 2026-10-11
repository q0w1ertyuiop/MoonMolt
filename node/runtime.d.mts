export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface RunRequest {
  command?: 'inspect' | 'status' | 'rehearse' | 'apply';
  db: string;
  dir?: string;
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
export interface BatchResult { applied: HistoryEntry[]; fingerprint: string }
export interface ReportPaths {
  stage?: 'prepare' | 'backup' | 'rehearse' | 'apply';
  backup?: string;
  incomplete_backup?: string;
  report_path?: string;
  report_warning?: string;
}
export type RunSuccess = ReportPaths & (
  | { ok: true; snapshot: { objects: Json[]; tables: Json[]; fingerprint: string; sqlite_version: string } }
  | { ok: true; command: 'status'; applied: HistoryEntry[]; pending: string[]; noop: boolean }
  | { ok: true; command: 'apply' | 'rehearse'; applied: HistoryEntry[]; pending: []; noop: true }
  | { ok: true; command: 'apply'; result: BatchResult; rehearsed: true; noop: false }
  | { ok: true; command: 'rehearse'; rehearsal: BatchResult; database_modified: false }
);
export interface Failure extends ReportPaths {
  ok: false;
  kind: 'input' | 'history_mismatch' | 'policy' | 'database' | 'lock_timeout' | 'commit_outcome_unknown' | 'runtime' | 'cleanup';
  exit_code: 1 | 2 | 3;
  message: string;
  cleanup_warnings?: string[];
  completed?: RunSuccess;
}
export type RunReport = RunSuccess | Failure;
/** Captures values and resolves relative paths immediately; owns queued connection lifecycle. */
export function run(request: RunRequest): Promise<RunReport>;

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
