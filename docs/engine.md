# Engine and host protocol

The MoonBit root package owns filename parsing, ordering, immutable history checks, schema drift detection, planning and execution order. JavaScript owns file bytes/SHA-256, SQLite connections, bindings, snapshots, authorizer callbacks and asynchronous backup.

`Driver.call(operation, arguments)` returns a JSON value or raises `MigrationError`. `prepare(driver, request)` loads immutable SQL, opens `source`, acquires the write lock for `apply`, and checks history. If `Prepared.backup_required` is true, the host makes a consistent backup through a separate read-only connection and opens a clone of the completed backup. `complete(driver, prepared)` performs rehearsal and real execution. Always release connections and roll back any surviving transaction in a `finally` block, including when preparation fails.

The Node bridge exposes `prepare_json`, `complete_json` and `plan_json`; these are transport functions. Applications should use the queued `run` entry point, which owns connection lifecycle and reports.

| Operation | Arguments | Result |
|---|---|---|
| `load` | `dir` | Array of `{filename, checksum, sql}`; strict UTF-8, raw-byte SHA-256 |
| `open` | `id, path, read_only, create, rebuild` | null; existing database unless explicitly created |
| `open_clone` | `rebuild` | null; completed snapshot copy opened as `clone` |
| `begin / commit / close` | `id` | null; engine-owned transaction/lifecycle |
| `history` | `id` | Ordered `HistoryEntry[]`, or empty if no metadata exists |
| `history_init` | `id` | null; history table created inside the active transaction |
| `history_insert` | `id, entry` | null; bound parameter insertion |
| `inspect` | `id` | `SchemaSnapshot` with raw schema objects and SQLite metadata |
| `fingerprint` | `id` | SHA-256 of deterministically ordered schema objects |
| `exec_script` | `id, sql, filename` | null; guarded SQLite execution, never split on semicolons |
| `validate` | `id` | null only when foreign_key_check is empty and quick_check is `ok` |
| `clock / timestamp` | empty object | Monotonic integer milliseconds / UTC ISO-8601 string |

Fingerprinting excludes SQLite-owned objects and the migration history table; it detects schema edits, not business-data changes. Column/index/foreign-key metadata is retained separately by inspection. Node query results preserve large integers as `{$int64: "decimal"}` and bytes as `{$blob: "base64"}` when transported as JSON; SQLite performs migration data copies directly without converting through JavaScript numbers.

History columns are `version` (integer primary key), `name`, `checksum`, `applied_at`, `duration_ms`, `schema_before`, `schema_after`, and `tool_version`. Its name is `__moonmigrate_history`. Checksums and fingerprints detect accidental drift; they are not signatures against a malicious actor with database write access.

Reports include `ok`, a command/result or failure `kind`/`message`/`exit_code`, execution stage, and persistent backup/report paths when available. Exit categories are 0 success, 1 input/database/runtime, 2 history/policy and 3 lock timeout. On uncertain COMMIT outcome, inspect the history through a fresh invocation before deciding whether another forward migration is needed.

Planning accepts the pinned upstream JSON format. Table arrays `columns`, `indexes`, `foreign_keys`, `checks`, `triggers`, and root `views` must be present; absent optional defaults/actions or JSON null are supported. Rename hints use `{"tables":[["old","new"]],"columns":[["target_table","old","new"]]}`. SQL expressions for defaults are trusted author input, not untrusted user input.

The native implementation is reserved behind `Driver`; this release ships the Node adapter only. MoonMolt does not claim arbitrary SQLite DDL can be losslessly transformed into the upstream model.
