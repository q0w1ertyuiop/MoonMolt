# Engine and host protocol

The MoonBit root package owns filename parsing, ordering, immutable history checks, schema drift detection, planning and execution order. JavaScript owns file bytes/SHA-256, SQLite connections, bindings, snapshots, authorizer callbacks and asynchronous backup.

`Driver.call(operation, arguments)` returns a JSON value or raises `MigrationError`. `prepare(driver, request)` loads immutable SQL, opens `source`, acquires the write lock for `apply` (a read transaction for other commands), and checks history. `Prepared` retains both the schema fingerprint and the complete history snapshot. Advisory rehearsal closes its source read transaction before backup so it does not hold readers across asynchronous work. If `Prepared.backup_required` is true, the host makes a consistent backup through a separate read-only connection and opens a clone of the completed backup. `complete(driver, prepared)` verifies the clone's fingerprint and history before executing anything, then performs rehearsal and real execution. Always release connections and roll back any surviving transaction in a `finally` block, including when preparation fails. Callers using the lower-level `status`/`inspect` helpers directly should own a read transaction around the entire operation.

The Node bridge exposes `prepare_json`, `complete_json` and `plan_json`; these are transport functions. Applications should use the queued `run` entry point, which owns connection lifecycle and reports.

| Operation | Arguments | Result |
|---|---|---|
| `load` | `dir` | Array of `{filename, checksum, sql, checks?}`; immutable SQL and optional checks |
| `open` | `id, path, read_only, create, rebuild` | null; existing database unless explicitly created |
| `open_clone` | `rebuild` | null; completed snapshot copy opened as `clone` |
| `begin / begin_read / commit / close` | `id` | null; engine-owned write/read transaction/lifecycle |
| `history` | `id` | Ordered `HistoryEntry[]`, or empty if no metadata exists |
| `history_init` | `id` | null; history table created inside the active transaction |
| `history_insert` | `id, entry` | null; bound parameter insertion |
| `inspect` | `id` | `SchemaSnapshot` with raw schema objects and SQLite metadata |
| `fingerprint` | `id` | SHA-256 of deterministically ordered schema objects |
| `sequences` | `id` | Business tables as `{name, seq?}`; omit absent seq, use decimal Int64 strings |
| `exec_script` | `id, sql, filename` | null; guarded SQLite execution, never split on semicolons |
| `exec_check` | `id, sql, name, filename` | null; one read-only query returning exactly one INTEGER 1 |
| `validate` | `id` | null only when foreign_key_check is empty and quick_check is `ok` |
| `clock / timestamp` | empty object | Decimal string of monotonic milliseconds / UTC ISO-8601 string |

Fingerprinting excludes SQLite-owned objects and the migration history table; it detects schema edits, not business-data changes. Column/index/foreign-key metadata is retained separately by inspection. Node query results preserve large integers as `{$int64: "decimal"}` and bytes as `{$blob: "base64"}` when transported as JSON; SQLite performs migration data copies directly without converting through JavaScript numbers.

History columns are `version` (integer primary key), `name`, `checksum`, `applied_at`, `duration_ms`, `schema_before`, `schema_after`, and `tool_version`. Its name is `__moonmigrate_history`. The Node adapter requires its exact engine-owned DDL and rejects attached triggers or extra indexes, including case-insensitive name collisions. The engine verifies adjacent schema fingerprints form a chain and durations are nonnegative. Checksums and fingerprints detect accidental drift; they are not signatures against a malicious actor with database write access.

Before and after each migration the engine compares AUTOINCREMENT sequence floors for tables retaining the same name. A lower or missing sequence fails the whole transaction; values never pass through JavaScript floating-point numbers. Intentional table deletion is permitted. Renames require reviewed SQL to move the appropriate sequence floor, since the executor cannot infer table identity from arbitrary SQL. Scripts should restore floors before inserting additional rows.

The MoonBit JSON codec represents `Int64` as a decimal string. Clock values and the `duration_ms` report field therefore use strings at the transport boundary; the adapter binds durations as SQLite integer values through JavaScript BigInt.

Reports include `ok`, a command/result or failure `kind`/`message`/`exit_code`, execution stage, and persistent backup/report paths when available. Exit categories are 0 success, 1 input/database/runtime, 2 history/policy and 3 lock timeout. On uncertain COMMIT outcome, inspect the history through a fresh invocation before deciding whether another forward migration is needed.

`run(request)` captures primitive values and resolves paths at invocation time, before entering the process queue. Host-only options are `busy_timeout_ms` (integer 0–2147483647, default 5000) and `backup_dir` (apply only, default `<db>.moonmolt-backups`). They configure the Node adapter and are not fields in the MoonBit `Request`. Both CLI and library reject inappropriate creation/inspection options. The shipped `runtime.d.mts` describes library requests and result unions. SQLite operations are synchronous and sessions are serialized process-wide; invoke upgrades at startup or in a maintenance worker when application responsiveness matters.

Planning accepts the pinned upstream JSON format. Table arrays `columns`, `indexes`, `foreign_keys`, `checks`, `triggers`, and root `views` must be present; absent optional defaults/actions or JSON null are supported. Rename hints use `{"tables":[["old","new"]],"columns":[["target_table","old","new"]]}`. SQL expressions for defaults are trusted author input, not untrusted user input.

The native implementation is reserved behind `Driver`; this release ships the Node adapter only. MoonMolt does not claim arbitrary SQLite DDL can be losslessly transformed into the upstream model.

## Business verification (0.2.0)

`MigrationSource` and `Migration` now have `checks: Array[MigrationCheck]?`; `MigrationCheck` contains `name` and `sql`. Existing host JSON may omit `checks`. MoonBit callers constructing these records must provide `checks: None` for SQL-only migrations. A custom driver must implement `exec_check` if it supplies checks; the engine invokes it after each script and sequence validation, before recording history. A failure must raise `Policy` and leave the owning transaction to be rolled back. Successful batch reports include `checks` entries with migration version, filename, check name and `ok: true`. No-op batches do not rerun checks.

The Node host reads `<migration basename>.checks.json` together with SQL. Its format is a nonempty `checks` array of uniquely named `{name, sql}` objects. Orphan files, unknown fields, symlinks and malformed JSON/UTF-8 are rejected. Without a sidecar the checksum stays `sha256(SQL raw bytes)`. With one, the checksum is SHA-256 over the UTF-8 string `moonmolt-checks-v1\0<SQL SHA-256 hex>\0<checks SHA-256 hex>`; the separators are literal NUL bytes. Whitespace changes in a checks file therefore invalidate applied history as SQL edits do.

The SQLite authorizer allows only read/select/function/recursive-query operations on the current database and its temporary tables, excluding reserved metadata access. The prepared statement's `sourceSQL` identifies the first SQLite-compiled statement; any tail containing more than comments, whitespace or empty terminators is rejected. The host fetches at most two rows as arrays with BigInt INTEGER values, so duplicate column labels and enormous result sets cannot conceal a malformed boolean result. SQL errors and unexpected results become policy failures naming the migration and check. Business rules are authored queries, not proofs of arbitrary data preservation; write accurate conditions rather than unconditional `SELECT 1` checks.
