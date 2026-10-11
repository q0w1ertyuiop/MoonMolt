# Development notes

## 2026-10-11 — choosing the execution boundary

The first implementation starts from an empty repository. The installed MoonBit compiler is 0.10.14 and Node.js is 26.2.0.

The existing `mizchi/sqlite@0.3.1` API provides a useful reference, but its documented JavaScript error reporting is insufficient for a migration executor. MoonMolt therefore uses Node's `node:sqlite` through a narrow adapter and keeps migration policy and orchestration in MoonBit.

Backups are asynchronous in Node. The engine will expose a prepare/complete protocol: preparation acquires the write lock and checks history, the adapter makes a consistent backup through a separate read-only connection, and completion rehearses and executes the immutable migration set. This keeps asynchronous I/O out of a synchronous FFI call without moving migration decisions into JavaScript.

The repository currently has no remote; development and validation can proceed locally.

## First executable checks

MoonBit's derived optional JSON fields accept absence, not JSON `null`. The initial Node request sent `to: null` and was rejected before execution. The host now omits an unset target, while schema planning normalizes `null` only for the upstream model's optional default and foreign-key action fields.

Real SQLite tests confirmed trigger bodies and strings containing semicolons work when scripts are passed intact to SQLite. Windows testing also exposed a fixture cleanup error: a WAL connection must be closed before deleting its database directory.

The upstream planner correctly rejects making a nullable column required without a backfill default. The rebuild test now supplies an explicit default rather than bypassing this check.

## Locking, crash recovery and model limits

The next checks use independent Node processes: two executors target the same database and only one applies the migration; the second becomes a no-op after checking history under the lock. A process is also killed after inserting history inside the real transaction but before COMMIT. Reopening the database recovers the original schema and data, and a subsequent upgrade succeeds.

Passing the raw schema snapshot directly into the planning model would lose features the model cannot express. These formats remain distinct. Automatic planning now rejects unknown fields, composite primary keys and decorated type declarations; the CLI's `inspect` output retains raw SQL and detailed SQLite metadata. Manual SQL remains available for advanced SQLite structures.

The rehearsal clone is checked against the fingerprint captured during preparation. This also detects a schema change between an advisory rehearsal and its backup.

SQLite exceptions use Node error codes beginning with `ERR_`; a broad filesystem-style error classifier initially labeled them as input errors. SQLite's numeric error field now takes precedence so execution failures are reported as database errors.

## Executing generated SQL through the guarded driver

A generated rebuild passed the planner tests but initially failed at runtime: SQLite reports the read-only `pragma_foreign_key_check` table-valued function to the authorizer as a PRAGMA operation. The adapter now allows only this argument-free read, keeping configuration PRAGMAs blocked. A real database test executes the generated draft, checks its backfill and confirms that the retained foreign-key guard works inside the engine transaction.

## Demonstration and distribution

The shop demo has now run end to end: order IDs, user references and monetary amounts survive three upgrades; an intentionally broken later migration leaves the previously committed batch intact; repeating the completed upgrade is a no-op. The saved report comes from this run rather than an example output.

The SVG architecture and logo were rendered locally and visually checked. The npm archive includes the compiled MoonBit engine, the host adapter and documentation, without source build caches or local files. An installation smoke check will verify the archive can run without MoonBit installed in the consumer project.

The initially assumed `moonbitlang/setup-moonbit` Action could not be found. CI uses the documented `hustcer/setup-moonbit` Action instead and tests the minimum supported Node.js version, 24.10.0, alongside Node.js 26.
