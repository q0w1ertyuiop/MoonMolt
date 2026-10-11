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
