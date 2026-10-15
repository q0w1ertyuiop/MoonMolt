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

Final lifecycle checks cover editing a migration file during backup: both execution stages still use the originally loaded SQL, and the next invocation detects the file change. Clock timestamps and durations use 64-bit values so a long-running application is not limited by signed 32-bit millisecond uptime. Backup reports distinguish a completed snapshot from an incomplete backup attempt.

The first 64-bit timing change exposed another codec boundary: MoonBit expects decimal strings for Int64 JSON, while the host was returning numbers. Clock and duration transports now consistently use decimal strings; SQLite receives bound BigInt values. All 18 integration cases passed on both Windows Node.js 24.10.0 and 26.2.0 after this correction. The four MoonBit tests and warning-free type/build checks passed as well.

The packed archive was installed in an independent consumer directory with lifecycle scripts disabled. Its CLI ran, and its library created, migrated and inspected a database using the included compiled engine. No MoonBit source or build step was needed in that consumer directory.

Integration review identified that independently loaded runtime modules could otherwise have separate queues around the same global FFI callback. The queue now uses a shared process symbol, with a test loading an independent runtime instance and issuing two upgrades concurrently.

The first remote CI run failed on every platform before compilation: fresh runners did not have the Mooncakes registry index. CI now runs `moon update`, and the source build script initializes the registry when no dependency cache exists. Local cached builds had concealed this setup requirement.

Two final fault probes check failure reporting: a lost COMMIT acknowledgement returns `commit_outcome_unknown` and a retry consults history rather than duplicating the committed update; a partial backup is explicitly reported as incomplete and leaves the source database unchanged.

The JavaScript library boundary also validates target versions as integers before invoking MoonBit's JSON decoder, so a fractional target cannot be silently converted to an integer.

## Application review: deleted IDs and embedded callers

A table rebuild copied its surviving IDs correctly but reset the AUTOINCREMENT sequence: a previously issued and deleted ID could be reused after upgrade. This matters for synchronization logs and references outside SQLite. The engine now checks sequence floors before and after each script and fails before modifying the source if a same-name table loses its floor. It deliberately requires explicit SQL preservation rather than guessing identity across table renames. The regression covers an empty table and a deleted ID above JavaScript's safe integer range; a corrected migration produces the next exact 64-bit ID.

The history reader previously accepted any table with a version primary key. A colliding empty metadata table with an insert trigger could change application rows when the engine recorded its first migration. The adapter now requires canonical history DDL with no attached objects and detects differently cased names. The core additionally verifies fingerprint continuity between entries and rejects negative durations.

Status and inspection formerly used independent implicit read transactions. A WAL writer could finish an upgrade between the history query and schema query, producing a false drift report. Preparation now owns a read snapshot. Rehearsal releases that snapshot before backup, then verifies both the clone's history and schema; a data-only migration in another process cannot slip through the schema-only comparison. Actual process tests cover both races.

Embedding exposed a separate queue boundary: requests were read only after earlier work completed. Mutating the input or changing the application's working directory could target a different database. The library now captures values and resolves paths synchronously at invocation. Lock waits and backup destinations are configurable, inappropriate command flags fail early, and the package ships a TypeScript declaration for its public requests and reports.

The first minimum-version rerun found a test parsing all stderr as JSON; Node 24 also prints its SQLite experimental warning there. The assertion now selects the JSON report line. This was a test portability issue rather than a migration failure.

After the correction, all 31 Node integration cases passed on Windows Node.js 24.10.0 and 26.2.0, alongside all four MoonBit tests and warning-free checks. The freshly packed archive was installed in an independent consumer with lifecycle scripts disabled; its public package exports ran apply/status/plan, and a strict TypeScript NodeNext consumer compiled successfully. The shop demo was rerun with intact orders, references and money amounts.

## 2026-10-12 — business verification in the local development batch

Schema and foreign-key checks still cannot distinguish a valid upgrade from one that accidentally clears every order amount. This batch adds optional per-migration SQL checks in a `.checks.json` sidecar. Both rehearsal and actual execution evaluate them inside the owning transaction, before writing history. A failed check rolls back the whole batch; a report names the migration and the failed business rule.

The sidecar is loaded once with the SQL and included in its checksum using a versioned hash domain. SQL-only migrations retain their previous byte hash, which avoids invalidating existing users' histories. Adding, weakening or deleting an applied sidecar deliberately causes a history mismatch.

SQLite's prepared statement API ignores a second statement after the first. A local probe confirmed `sourceSQL` gives precisely the compiled prefix, including leading comments. The check executor rejects nontrivial tails and uses the authorizer to reject writes. It reads array results rather than objects, since duplicate result column names could otherwise hide a second column. Only a single INTEGER 1 is accepted, and at most two rows are consumed.

The initial warning-free build rejected implicit method promotion on the new public MoonBit type. Its derived methods now use explicit extensions, matching the existing package's JSON API conventions. The earlier compiled artifact was not used as validation for the new feature; the targeted checks were rerun after a successful rebuild.

Final local validation passed all 40 Node integration tests on Windows Node.js 24.10.0 and 26.2.0, plus five MoonBit tests and warning-free build/check. The order demo passed two named business checks with unchanged monetary totals and foreign keys. The 0.2.0 npm archive ran business checks through its public exports in an independent consumer, and its strict TypeScript consumer compiled. The SVG was rendered and visually checked. This batch is committed locally; no remote CI or package publication is claimed.

## 2026-10-12 — responsive applications and progress

The next local batch addresses the synchronous SQLite boundary. `runInWorker` creates an isolated engine session while preserving transaction, rehearsal and business-check rules. A regression holds a database write lock in the parent, starts a worker upgrade, then releases the lock from a timer after receiving the begin event. The migration completes, demonstrating the parent event loop remains responsive during the worker's lock wait. Two simultaneous workers targeting the same database produce one upgrade and one no-op.

Progress observers are telemetry rather than policy. Throwing observers and rejected async callbacks are isolated and recorded as bounded warnings; callbacks cannot turn a committed migration into a reported rollback. A fault preload exits the worker immediately after source COMMIT: the parent returns an uncertain outcome and the completed backup, and retrying consults history without incrementing data again.

The first worker tests failed because explicitly forwarding every Node execArgv flag also forwarded process-only flags from Node's test runner. Default Worker inheritance already filters these correctly, so it is preserved except when file workers must remove an eval/stdin input-type option. After this correction the worker regressions passed. Paths are captured before constructing workers, and results resolve after thread exit so Windows cleanup does not race open files.

All 49 integration tests passed locally on Windows Node.js 24.10.0 and 26.2.0, alongside five MoonBit tests and warning-free checks. The 0.3.0 archive's worker, progress and status APIs ran in an independent consumer; its strict TypeScript consumer passed. The SVG was rendered and visually checked. This remains local development with no remote CI run or publication for this batch.

## 2026-10-16 — cancellation with transaction outcome preserved

The worker made applications responsive, but closing a progress view could only wait for completion or kill its thread. This batch adds AbortSignal cancellation and a shared internal session lifecycle. A shared atomic flag carries requests into synchronous worker execution without waiting for the worker's message loop. The parent retains ownership of its signal and removes listeners after the worker exits.

The initial cancellation tests cover pre-aborted requests, queued sessions, completed backups, source SQL already executed, and the final pre-COMMIT checkpoint. A deterministic worker probe pauses after a real source write, waits for the shared cancellation flag, then confirms data, DDL and history roll back together. No forced thread termination is used.

A lock wait can fail with SQLITE_BUSY after cancellation was requested. The adapter now recognizes cancellation at that safe boundary, while explicitly preserving uncertain COMMIT outcomes. A separate fault test commits, requests cancellation and loses the acknowledgement: it still reports uncertainty rather than claiming rollback. A completed COMMIT with an acknowledgement remains a success despite late cancellation.

CLI SIGINT/SIGTERM handlers request the same cancellation and wait for cleanup. The portable CLI probe emits the Node SIGINT event while a worker waits on a lock; it exercises the registered handler and cancellation exit code without relying on Windows child-process signal emulation.

Local verification passed 58 Node integration tests on Windows Node.js 24.10.0 and 26.2.0 and six MoonBit tests. The freshly packed 0.4.0 archive passed worker/cancel/create/status checks in an independent consumer, and the strict TypeScript signal consumer compiled. The updated architecture SVG was rendered and visually checked. The previously local 0.2.0/0.3.0 commits are included in this push batch; remote CI results are checked after push rather than inferred from local runs.

The first remote run used a newer MoonBit core than the installed local toolchain and failed strict checks on deprecated primitive `.to_json()` methods. The explicit `ToJson::to_json(value)` trait operation was already used elsewhere in the engine and verified locally with `moon ide doc 'ToJson'`. All transport conversions now use that form so older and newer toolchains can share the same source, with warnings still treated as errors. The full local build and regressions were rerun after changing the source.

## 2026-10-16 — bundled applications and guarded deployment

An embedded application previously needed an external SQL directory even when all upgrade text was already in its bundle. The new `migrations` input captures strings before queueing or worker creation. A shared loader computes the same checksums for files and bundles. I kept the checks sidecar as raw `checks_json` rather than accepting an object: parsing and reserializing an existing document would invalidate its byte-based history. Tests switch a live database between both loaders with BOM, Chinese text and CRLF intact, and deliberately reject formatting changes afterward.

The second gap was selecting the wrong application file or deploying against an outdated version assumption. The MoonBit engine now checks optional application ID and current version expectations under its owning transaction, including no-op calls. Application IDs are only read, never assigned. A regression runs two workers expecting version 0; one upgrades and the other rejects the now-stale condition after acquiring its lock. Advisory rehearsal also compares the clone's application ID because schema/history checks alone miss a changed header.

The first direct-engine test used a read-only JSON constructor and an assertion helper absent from the installed test package. `moon ide doc 'Json'` and `moon ide doc '@test.assert*'` confirmed `Json::null()` and `assert_eq` as the supported APIs; the corrected tests then compiled and passed. The source and generated public interfaces include the new optional request fields and snapshot identity, with the custom-driver protocol changes documented.

Initial full verification passed 68 Node integration tests and seven MoonBit tests. The new notes example ran with bundled migrations, business verification, stale-version rejection and a successful no-op retry while retaining the original Chinese note. Minimum-version, packaged-consumer and remote CI checks are recorded only after they run.

The Windows suite also passed on Node.js 24.10.0 as well as 26.2.0. The 0.5.0 archive was installed in an independent consumer with lifecycle scripts disabled; its bundled worker upgrade, guards, status and no-op calls ran without a MoonBit toolchain in that consumer, and a strict TypeScript NodeNext consumer compiled. The updated SVG was rendered and checked visually. The earlier shop demo was rerun successfully. Remote CI remains a separate check after push.
