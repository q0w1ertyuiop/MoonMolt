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

## 2026-10-16 — user data baselines rather than fixed fixture totals

The next review found a concrete false-positive check: SQLite executes an unbound `:minimum` as NULL. After a script cleared every order amount, `NOT EXISTS(SELECT 1 FROM orders WHERE amount < :minimum)` still passed. The new regression first failed against 0.5.0 by showing a successful lossy upgrade, then passed after rejecting parameters before executing a check. A local parser probe and Node's `expandedSQL` documentation confirmed that actual placeholders expand to NULL, while question marks in literals and comments remain literal. This fix was committed separately before extending verification.

Existing checks also made callers encode fixed expected amounts or manage their own before/after baselines. The new optional `preserve` group captures scalar query results before a migration and compares them after it, within the owning clone/source transaction. I reused `MigrationCheck` and the checksum domain rather than introducing a second manifest or a parallel loader. Type tags preserve exact Int64 values, null, finite reals, text and blob distinctions; captured values never enter reports. A shared scalar executor keeps ordinary checks and preservation under the same authorizer and single-statement rules.

Real SQLite probes cover empty and populated databases, a one-unit loss above JavaScript's safe integer range, a source-only failure after a successful rehearsal, storage-class changes and cancellation between the source write and post-capture. The source-only failure rolls back the earlier script as well as the rebuild, data and history; its retained backup remains intact. The source capture events needed their stage set before the first baseline query, otherwise a before-capture failure would have inherited the previous rehearsal stage. Tests now check stage and phase for both connections.

Initial strict build/check and all nine MoonBit tests passed, followed by all 80 Node integration tests on Windows Node.js 26.2.0. Minimum-version, packaged-consumer and remote CI outcomes are checked separately. Existing example migration files were left intact; the new runnable preservation example has its own pending migration and demonstrates rejecting a row-loss bug before a corrected upgrade.

Two further regressions cover changes within the same TEXT/BLOB/REAL type and comparing invalid legacy UTF-8 TEXT bytes through an explicit BLOB cast. The final 82 integration tests passed on both Node.js 24.10.0 and 26.2.0. All three runnable examples passed. An independent consumer installed the 0.6.0 archive with lifecycle scripts disabled and ran the preservation upgrade, plus its strict TypeScript consumer. A database created through the actual packed 0.5.0 runtime with SQL-only and checks-only history was accepted by the packed 0.6.0 runtime, then upgraded with a new preservation migration. The SVG was rendered and visually checked. These are local results; remote CI is checked after pushing.

## 2026-10-16 — executable SQL boundaries and recovery verification

The next application review checked migration bodies, not only verification queries. The new two-migration regression failed against 0.6.0 because an unbound balance parameter was accepted, despite there being no binding API for scripts. SQLite's prepared statement exposes the first complete SQL prefix, including trigger bodies. The host now compiles, checks and executes each SQLite-delimited statement in order, keeping dependency on preceding DDL valid and preserving authorizer rules. It rejects actual parameters while accepting their spelling inside quoted identifiers, strings and comments. A local probe also found that reading `sourceSQL` on a comment-only prepared statement throws `ERR_INVALID_STATE`; a small leading-trivia scan handles that case without trying to parse SQL statements itself. The fix was committed separately.

Recovery still required copying validation steps by hand. A new read-only `verify` command reuses file/bundle loading, history and identity conditions, then performs full integrity and foreign-key checks in the same read snapshot. A deliberately inconsistent index passed `quick_check` but failed `integrity_check`, making the distinction testable rather than a label change. Migration validation keeps its existing quick scan. Both modes now stream bounded findings: 20 shown, plus one row to decide whether omission must be reported.

The initial verification tests accidentally passed an explicit undefined options argument to `DatabaseSync`, which the installed API rejects; their helper now defaults to an object. A second fixture had incremented a foreign key without adding a parent row; it now uses an index-only migration before deliberately injecting the intended corruption. After correcting those fixtures, all ten verification scenarios passed: a retained pre-upgrade backup with pending migrations, index inconsistency, data-only foreign-key damage after a completed batch, checksum/drift/identity/version failures, bounded diagnostics, a concurrent WAL upgrader, historical business checks not replayed, cancellation cleanup, and CLI/library option validation.

All 96 integration tests passed on Windows Node.js 26.2.0 and 24.10.0, alongside ten MoonBit tests and warning-free checks. The generated MoonBit public interface remained unchanged; the command/report addition is represented by the existing command string and the Node declaration union. Packaged-consumer and remote CI outcomes are checked after their actual runs.

A final lexical probe checked each ASCII whitespace candidate against SQLite: vertical tab (0x0B) is rejected, so the trivia scanner was tightened and a regression preserves that rejection after an earlier write. Two more scenarios verify that RETURNING fully consumes updates and trigger effects, and that cancellation between source statements stops later DDL and rolls back earlier writes. All final 98 integration tests passed on both supported local Node versions. The 0.7.0 archive passed an independent installation with lifecycle scripts disabled, the upgraded preservation/backup-verification example, strict TypeScript checks, and a compatibility run using actual packed 0.6.0 preservation history. The latter verified the old database, applied a new index migration and verified its retained backup with the expected historical version. All three examples ran successfully and the updated SVG was rendered and visually checked. Remote CI is checked after push.

## 2026-10-16 — trusted initial schemas and temporary helpers

The next review reproduced a business-check false positive without parameters: copying `main.orders` into `temp.orders` made an unqualified check read the preserved temporary amounts after the script cleared the main table. The regression first failed against 0.7.0. I added a statement-boundary namespace check and committed the fix separately. It checks after relevant DDL rather than only at the end of a script, because a later DROP would conceal the collision. Distinct helpers remain available across scripts. Additional regressions cover case differences, views, renames, a source-only collision after successful rehearsal, and legitimate independent index names and SQLite sequence objects.

A legacy database with no history also had no trusted schema baseline. Application ID and version 0 could both match while an unexpected trigger changed upgrade behavior. The new optional expected_fingerprint checks an earlier reviewed schema under the owning transaction, before backup or SQL. Tests cover all database commands, no-ops, two concurrent workers, captured request values, malformed digests before creation and preserved history-drift diagnostics. Data-only changes intentionally leave the hash unchanged. The expectation is not automatically refreshed after mismatch, and the bundled notes example makes the review boundary and stale-schema behavior explicit.

Preparation now obtains one fingerprint for drift and preconditions, and the host hashes raw ordered schema objects directly rather than loading all inspection metadata. Detailed PRAGMAs explicitly address main. The public MoonBit interface adds only the optional request field; custom drivers retain their existing operations. Status, verification and no-op reports expose the current schema fingerprint for application reuse.

All 112 Node integration tests passed on Windows Node.js 26.2.0 and 24.10.0, with 12 MoonBit tests, warning-free checks and a successful build. Packaged compatibility and remote CI are recorded only after they run.

The 0.8.0 archive was installed in an independent consumer with lifecycle scripts disabled. Actual packed 0.7.0 history, including a preservation sidecar, retained exactly the same fingerprint under 0.8.0 status and verification. A guarded new index upgrade succeeded, its retained backup verified against the old version and fingerprint, a stale retry failed, and a new-fingerprint no-op succeeded. A conflicting TEMP copy was rejected with amounts and history unchanged. The strict TypeScript consumer initially narrowed on the presence of `noop`, which also exists as false on completed apply reports; checking its true value corrected the consumer and compilation passed. All three examples passed, the updated embedding example also passed on Node.js 24.10.0, and the SVG was rendered and visually checked. Remote CI remains a separate post-push check.

## 2026-10-16 — current application verification and protected renames

The previous 0.8.0 head was confirmed on remote main with successful CI before this batch began. A new regression then showed a rename could move a business table into `__moonmigrate_` and commit successfully, although later migration queries could no longer access it. SQLite authorizes ALTER_TABLE with the database and old name, not the new one. The fix checks resulting objects after affected DDL and was committed separately; tests include mixed case and TEMP names.

Read-only verification still could not test current application facts. I added optional verify_checks, reusing the core's existing MigrationCheck and host exec_check operation. The rules are captured at invocation, independent of immutable history; CLI accepts an explicit checks document. They execute after full integrity checks, in the same read transaction. A WAL regression commits zero amounts between integrity checking and the custom query: the original invocation sees its consistent old snapshot, while a fresh invocation rejects the now-damaged data. Neither invocation repairs or migrates anything.

The first new MoonBit fixture accidentally added its exec_check branch to the neighboring preservation driver; moving it into VerificationDriver corrected the test failure. Strict checking also required an explicit rest marker in the nested JSON map pattern. After correcting those tests, all 13 MoonBit tests and warning-free checks passed. All 121 Node integration tests passed on Windows Node.js 24.10.0 and 26.2.0, covering unsafe SQL, malformed manifests, queue/worker capture, failed guards, cancellation and CLI outcomes. The generated public interface adds only the optional request field. Packaged compatibility and remote CI results are recorded after they run.

All three runnable examples passed, including the extended preservation example on Node.js 24.10.0. It demonstrates that a later amount-clearing write passes plain SQLite verification and fails the explicit current business predicate. The 0.9.0 archive was independently installed with lifecycle scripts disabled; actual packed 0.8.0 preservation history retained its fingerprint, upgraded with a guarded index migration, and its retained backup passed both historical and current business verification. Reserved renames and later data damage were rejected without repair. A strict TypeScript NodeNext consumer compiled successfully, and the architecture SVG was rendered and visually checked. Remote CI is checked after push.

## 2026-10-16 — private backup artifacts and collision ownership

The 0.9.0 head was confirmed on remote main with successful CI. This batch focuses on snapshot files rather than extending the migration API. Backups and reports previously relied on the filesystem's default creation permissions, which can be broader than a private source database. The backup path was also published before the destination existed. The initial regression failed because no file had been reserved at its start event.

A separate probe used the actual packed 0.9.0 runtime, fixed the generated timestamp/UUID, and placed an existing valid SQLite archive at the chosen destination. The old runtime returned success and the archive table disappeared: SQLite's backup API replaced the destination contents. The regression now requires that existing database's bytes remain intact, with no backup/incomplete-backup/report path claimed by the failed session. The adapter reserves with wx before publishing or opening the destination and assigns ownership only after reservation succeeds.

New snapshots and JSON reports use POSIX 0600 and new persistent backup directories use 0700. Existing directory permissions are left to deployment policy; Windows inherits directory ACLs rather than POSIX owner/group restrictions. The tests also cover rehearsal cleanup, a completed migration whose report filename collides, a backup directory supplied as a file, and a real failed rehearsal retaining its usable backup and failure report. The report-collision test preserves success and avoids encouraging a replay after COMMIT.

Strict MoonBit checks, all 13 MoonBit tests and build passed; the generated public interface is unchanged. Both Windows Node.js 24.10.0 and 26.2.0 ran 129 integration tests: 127 passed and two POSIX permission cases were explicitly skipped. Those mode assertions require Linux/macOS and are not claimed as locally verified. Packaged checks and remote CI are recorded after they run.

The independently installed 0.9.1 archive passed with lifecycle scripts disabled. It accepted actual packed 0.9.0 preservation history and fingerprint, performed a new guarded index upgrade with the backup reserved before its start event, verified the retained backup through a worker, and returned a backup-free no-op. A later failed rehearsal preserved the original note and retained an accurate failure report. Its strict TypeScript NodeNext consumer compiled. All three examples ran successfully and the updated SVG was rendered and visually checked. Remote permission checks remain pending until push and CI complete.

## 2026-10-17 — delayed schema programs and application writes

The 0.9.1 remote head and all six CI jobs, including actual Linux/macOS permission assertions, were confirmed before this batch. A local SQLite authorizer probe then showed no protected-table access while creating a trigger whose body deleted migration history; preparing its INSERT event exposed that access. The new regression failed against 0.9.1 with a successful migration. An actual packed 0.9.1 consumer confirmed the consequence: one ordinary application insert reduced history from one row to zero.

The Node adapter now compiles main view queries and trigger target write paths before batch validation and read-only verification. It does not step the prepared statements, parse VDBE output or execute synthetic writes. Authorizer restrictions reject protected metadata access, and unresolved final definitions fail closed. Forward references remain valid if resolved by the end of the batch. Tests cover INSERT/DELETE/column-specific UPDATE, indirect view access, writable INSTEAD OF views, generated columns, a reviewed forward repair and a source-only failure after successful rehearsal.

A follow-up regression found the first implementation missed UPDATE OF rowid when only the declared INTEGER PRIMARY KEY was assigned. I added SQLite-resolved rowid/_rowid_/oid probes, including real columns shadowing those names and WITHOUT ROWID tables. SQLite's tolerated UPDATE OF nonexistent-column case stays dormant until a later migration adds that column; the regression confirms activation then fails before source modification. These checks validate current compiled paths rather than claiming every trigger's business semantics are safe.

Both Windows Node.js 24.10.0 and 26.2.0 ran 139 integration tests: 137 passed and the two POSIX mode assertions were skipped. Strict checks, all 13 MoonBit tests and build passed; the public MoonBit interface is unchanged. Package compatibility, examples and remote CI are recorded after actual validation.

The independently installed 0.9.2 archive passed with lifecycle scripts disabled and a strict TypeScript NodeNext consumer. It accepted actual packed 0.9.1 history and fingerprint, rejected a pending history-erasing trigger, detected that trigger when installed by the old runtime, and completed an explicit forward repair. A subsequent application write retained all three history entries. The pre-repair snapshot still failed definition verification, while the earlier good backup passed; neither snapshot was silently modified. All three examples ran, the extended notes example also passed on Node.js 24.10.0, and the SVG was rendered and visually checked. Remote CI is checked after push.

## 2026-10-17 — declared view events rather than error suppression

The user's retry pushed the existing 0.9.2 head successfully, and all six remote CI jobs passed while this batch was being developed. The next review found a definition-check false negative: an INSTEAD OF INSERT body tried to UPDATE the same view without an UPDATE trigger. The old validator suppressed the resulting cannot-modify-view error as though INSERT itself were undeclared. The new regression first failed against 0.9.2. An independent probe of the actual packed runtime returned migration success, then the application's INSERT failed with that error.

Authorizer traces did not reliably distinguish the unsupported outer operation from the broken nested body: both INSERT cases exposed the same top-level callback before the error. Instead of adding more exception heuristics, a limited quote/comment-aware reader now obtains the INSTEAD OF event from SQLite's already-accepted header. It stops before the body and leaves body compilation and statement boundaries to SQLite. Only declared events are compiled, so body failures are no longer swallowed. Tests cover all three events, single-operation views, multiple events on one view, mixed case, comments, BEGIN as a name, all quote forms, doubled quotes and fake event words inside names.

A compatibility probe checked UPDATE OF a nonexistent view column. Unlike a dormant ordinary-table event, such a view cannot perform its declared UPDATE at all until its dependencies are ready. The stricter validator rejects that final state; the regression also confirms a later script in the same batch can add the column and make the operation usable. This boundary is documented instead of silently retaining the old fallback. Legacy bad definitions can still be diagnosed read-only and repaired by a forward migration. Packaged compatibility and final verification results are recorded after running them.

Final local verification ran 146 integration tests on each of Windows Node.js 24.10.0 and 26.2.0: 144 passed and the two POSIX permission cases were skipped. All 13 MoonBit tests, strict checks and build passed, with no generated public-interface change. An independent consumer installed the 0.9.3 archive with lifecycle scripts disabled and compiled a strict TypeScript NodeNext consumer. It accepted actual packed 0.9.2 checksums/history/fingerprint, diagnosed the old broken view, applied a forward repair with a quoted fake-event trigger name, verified the repaired database and performed a successful application insert and no-op. Earlier good and pre-repair bad backups retained their respective verification outcomes. All three examples passed and the SVG was rendered and visually checked. This batch's remote CI is checked after pushing its own head.
