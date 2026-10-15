import { DatabaseSync, backup, constants as C } from 'node:sqlite';
import { readFileSync, readdirSync, lstatSync, existsSync, realpathSync, mkdirSync, mkdtempSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { migrationSource } from './migrations.mjs';

export const HISTORY = '__moonmigrate_history';
const HISTORY_DDL = `CREATE TABLE "${HISTORY}" (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL, duration_ms INTEGER NOT NULL, schema_before TEXT NOT NULL, schema_after TEXT NOT NULL, tool_version TEXT NOT NULL)`;
const hash = data => createHash('sha256').update(data).digest('hex');
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const failure = (kind, message) => Object.assign(new Error(message), { kind });
function portable(value) {
  if (typeof value === 'bigint') return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : { $int64: String(value) };
  if (value instanceof Uint8Array) return { $blob: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(portable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, portable(v)]));
  return value;
}

/** A session owns every connection and temporary artifact; cleanup runs even on FFI errors. */
export class Adapter {
  connections = new Map();
  temp = null;
  backupPath = null;
  clonePath = null;
  sourcePath = null;
  persistentBackup = false;
  backupComplete = false;
  stage = 'prepare';

  constructor({ busy_timeout_ms = 5000, backup_dir, migrations, onProgress = () => {}, isCancelled = () => false } = {}) {
    if (!Number.isInteger(busy_timeout_ms) || busy_timeout_ms < 0 || busy_timeout_ms > 2147483647) throw failure('input', 'invalid busy_timeout_ms');
    this.busyTimeout = busy_timeout_ms;
    this.backupDir = backup_dir;
    this.migrations = migrations;
    this.onProgress = onProgress;
    this.isCancelled = isCancelled;
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 24 || (major === 24 && minor < 10)) throw failure('input', 'MoonMolt requires Node.js >=24.10.0');
    if (typeof DatabaseSync.prototype.setAuthorizer !== 'function' || typeof backup !== 'function') throw failure('input', 'node:sqlite authorizer and backup APIs are required');
  }

  db(id) {
    const connection = this.connections.get(id);
    if (!connection) throw failure('database', `connection ${id} is not open`);
    return connection.db;
  }

  throwIfCancelled() {
    if (this.isCancelled()) throw failure('cancelled', 'migration cancelled before commit; active transaction will be rolled back');
  }

  query(id, sql, ...params) {
    const statement = this.db(id).prepare(sql);
    statement.setReadBigInts(true);
    return portable(statement.all(...params));
  }

  open({ id, path, read_only = false, create = false, rebuild = false }) {
    path = resolve(path);
    if (!existsSync(path) && !create) throw failure('input', `database does not exist: ${path}; use apply --create explicitly`);
    if (this.connections.has(id)) throw failure('input', `connection ${id} already open`);
    if (existsSync(path)) path = realpathSync(path);
    const db = new DatabaseSync(path, { readOnly: read_only, allowExtension: false });
    this.connections.set(id, { db, path, read_only });
    db.exec(`PRAGMA busy_timeout=${this.busyTimeout};`);
    db.exec(`PRAGMA foreign_keys=${rebuild ? 'OFF' : 'ON'};`);
    db.exec('PRAGMA trusted_schema=OFF;');
    const mode = this.query(id, 'PRAGMA journal_mode')[0].journal_mode;
    if (!read_only && ['off', 'memory'].includes(mode.toLowerCase())) throw failure('policy', `unsafe journal mode: ${mode}`);
    if (id === 'source') this.sourcePath = path;
    return null;
  }

  inspect(id) {
    const objects = this.query(id, 'SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE substr(name,1,7)<>\'sqlite_\' AND name<>? ORDER BY type,name', HISTORY);
    const tables = objects.filter(o => o.type === 'table').map(table => ({
      name: table.name, sql: table.sql,
      columns: this.query(id, `PRAGMA table_xinfo(${quote(table.name)})`),
      foreign_keys: this.query(id, `PRAGMA foreign_key_list(${quote(table.name)})`),
      indexes: this.query(id, `PRAGMA index_list(${quote(table.name)})`).map(index => ({ ...index, columns: this.query(id, `PRAGMA index_xinfo(${quote(index.name)})`) })),
    }));
    return { objects, tables, fingerprint: hash(JSON.stringify(objects)), sqlite_version: this.query(id, 'SELECT sqlite_version() AS version')[0].version, application_id: this.query(id, 'PRAGMA main.application_id')[0].application_id };
  }

  history(id) {
    const objects = this.query(id, 'SELECT type,name,sql FROM main.sqlite_schema WHERE name=? COLLATE NOCASE OR tbl_name=? COLLATE NOCASE', HISTORY, HISTORY);
    if (!objects.length) return [];
    if (objects.length !== 1 || objects[0].type !== 'table' || objects[0].name !== HISTORY || objects[0].sql?.replace(/\s+/g, ' ').trim() !== HISTORY_DDL) {
      throw failure('policy', 'invalid migration history table: expected engine-owned schema without triggers or additional indexes');
    }
    return this.query(id, `SELECT version,name,checksum,applied_at,CAST(duration_ms AS TEXT) AS duration_ms,schema_before,schema_after,tool_version FROM ${quote(HISTORY)} ORDER BY version`);
  }

  sequences(id) {
    const tables = this.query(id, "SELECT name FROM main.sqlite_schema WHERE type='table' AND substr(name,1,7)<>'sqlite_' AND name<>? ORDER BY name", HISTORY);
    const exists = this.query(id, "SELECT name FROM main.sqlite_schema WHERE name='sqlite_sequence'").length;
    const sequences = exists ? this.query(id, 'SELECT name,CAST(seq AS TEXT) AS seq FROM main.sqlite_sequence') : [];
    return tables.map(table => {
      const entries = sequences.filter(row => row.name === table.name);
      if (entries.length > 1) throw failure('policy', `duplicate sqlite_sequence entries for ${table.name}`);
      return entries.length && entries[0].seq !== null ? { name: table.name, seq: entries[0].seq } : table;
    });
  }

  script(id, sql, filename) {
    const db = this.db(id);
    if (!db.isTransaction) throw failure('policy', 'migration requires an active engine transaction');
    let denied = null;
    const controls = new Set([C.SQLITE_TRANSACTION, C.SQLITE_SAVEPOINT, C.SQLITE_ATTACH, C.SQLITE_DETACH, C.SQLITE_PRAGMA]);
    db.setAuthorizer((action, a, b, database) => {
      if (this.isCancelled()) return C.SQLITE_DENY;
      const reserved = value => typeof value === 'string' && value.toLowerCase().startsWith('__moonmigrate_');
      // The upstream rebuild guard uses the pragma_foreign_key_check table-valued
      // function. SQLite authorizes that read as SQLITE_PRAGMA as well.
      const readOnlyForeignKeyCheck = action === C.SQLITE_PRAGMA && a?.toLowerCase() === 'foreign_key_check' && b == null;
      if ((controls.has(action) && !readOnlyForeignKeyCheck) || reserved(a) || reserved(b) || (database && !['main', 'temp'].includes(database))) {
        denied = `disallowed operation ${action} on ${a ?? ''} ${b ?? ''}`;
        return C.SQLITE_DENY;
      }
      return C.SQLITE_OK;
    });
    try { db.exec(sql); }
    catch (error) { this.throwIfCancelled(); throw denied ? failure('policy', `${filename}: ${denied}`) : Object.assign(error, { message: `${filename}: ${error.message}` }); }
    finally { db.setAuthorizer(null); }
    if (!db.isTransaction) throw failure('policy', `${filename}: transaction ended unexpectedly`);
  }

  check(id, sql, name, filename) {
    const db = this.db(id);
    if (!db.isTransaction) throw failure('policy', 'business checks require an active engine transaction');
    const label = `${filename}: check ${JSON.stringify(name)}`;
    const reads = new Set([C.SQLITE_SELECT, C.SQLITE_READ, C.SQLITE_FUNCTION, C.SQLITE_RECURSIVE]);
    let denied = false;
    db.setAuthorizer((action, a, b, database) => {
      if (this.isCancelled()) return C.SQLITE_DENY;
      const reserved = value => typeof value === 'string' && value.toLowerCase().startsWith('__moonmigrate_');
      if (!reads.has(action) || reserved(a) || reserved(b) || (database && !['main', 'temp'].includes(database))) {
        denied = true; return C.SQLITE_DENY;
      }
      return C.SQLITE_OK;
    });
    let iterator;
    try {
      const statement = db.prepare(sql);
      // sqlite3_sql exposes precisely the compiled first statement. Reject an
      // ignored tail without splitting strings, comments or trigger bodies.
      const tail = sql.slice(statement.sourceSQL.length);
      if (!sql.startsWith(statement.sourceSQL) || !/^(?:\s|;|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*$/.test(tail)) throw failure('policy', `${label}: exactly one read-only query is required`);
      // With no binding API, SQLite would treat parameters as NULL. In a
      // NOT EXISTS predicate that can accidentally make an invalid check true.
      if (statement.expandedSQL !== statement.sourceSQL) throw failure('policy', `${label}: parameters are not supported; use a complete query`);
      statement.setReadBigInts(true); statement.setReturnArrays(true);
      iterator = statement.iterate();
      const first = iterator.next(), second = iterator.next();
      if (first.done || !second.done || first.value.length !== 1 || first.value[0] !== 1n) {
        throw failure('policy', `${label}: expected exactly one row and one INTEGER 1 result`);
      }
      return null;
    } catch (error) {
      this.throwIfCancelled();
      if (denied) throw failure('policy', `${label}: business checks must be read-only`);
      if (error.kind) throw error;
      throw failure('policy', `${label}: ${error.message}`);
    } finally {
      try { iterator?.return(); } finally { db.setAuthorizer(null); }
    }
  }

  load(dir) {
    const source = (filename, bytes, checksBytes) => {
      try { return migrationSource(filename, bytes, checksBytes); }
      catch (error) { throw failure('input', error.message); }
    };
    if (this.migrations !== undefined) return this.migrations.map(entry => source(entry.filename, Buffer.from(entry.sql), entry.checks_json === undefined ? undefined : Buffer.from(entry.checks_json)));
    const files = readdirSync(dir, { withFileTypes: true });
    const sqlNames = new Set(files.filter(f => f.name.endsWith('.sql')).map(f => f.name));
    for (const f of files.filter(f => f.name.endsWith('.checks.json'))) {
      if (!sqlNames.has(f.name.slice(0, -'.checks.json'.length) + '.sql')) throw failure('input', `orphan checks file: ${f.name}`);
    }
    return files.filter(f => f.name.endsWith('.sql')).map(f => {
      if (!f.isFile()) throw failure('input', `migration must be a regular file: ${f.name}`);
      const bytes = readFileSync(join(dir, f.name));
      const checksName = f.name.slice(0, -4) + '.checks.json';
      const present = files.some(candidate => candidate.name === checksName);
      if (!present) return source(f.name, bytes);
      const path = join(dir, checksName);
      if (!lstatSync(path).isFile()) throw failure('input', `checks must be a regular file: ${checksName}`);
      return source(f.name, bytes, readFileSync(path));
    });
  }

  dispatch(op, a) {
    switch (op) {
      case 'load': return this.load(a.dir);
      case 'open': return this.open(a);
      case 'open_clone': this.stage = 'rehearse'; return this.open({ id: 'clone', path: this.clonePath, rebuild: a.rebuild });
      case 'begin': this.db(a.id).exec('BEGIN IMMEDIATE;'); return null;
      case 'begin_read': this.db(a.id).exec('BEGIN;'); return null;
      case 'history': return this.history(a.id);
      case 'application_id': return this.query(a.id, 'PRAGMA main.application_id')[0].application_id;
      case 'sequences': return this.sequences(a.id);
      case 'inspect': return this.inspect(a.id);
      case 'fingerprint': return this.inspect(a.id).fingerprint;
      case 'history_init': this.history(a.id); this.db(a.id).exec(HISTORY_DDL.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ') + ';'); return null;
      case 'exec_script': this.stage = a.id === 'source' ? 'apply' : 'rehearse'; this.script(a.id, a.sql, a.filename); return null;
      case 'exec_check': return this.check(a.id, a.sql, a.name, a.filename);
      case 'history_insert': {
        const e = a.entry;
        this.db(a.id).prepare(`INSERT INTO ${quote(HISTORY)} VALUES (?,?,?,?,?,?,?,?)`).run(e.version, e.name, e.checksum, e.applied_at, BigInt(e.duration_ms), e.schema_before, e.schema_after, e.tool_version);
        return null;
      }
      case 'validate': {
        const fk = this.query(a.id, 'PRAGMA foreign_key_check');
        if (fk.length) throw failure('policy', `foreign key check failed: ${JSON.stringify(fk)}`);
        const integrity = this.query(a.id, 'PRAGMA quick_check');
        if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw failure('policy', `integrity check failed: ${JSON.stringify(integrity)}`);
        return null;
      }
      case 'commit': {
        const db = this.db(a.id);
        try { db.exec('COMMIT;'); }
        catch (error) {
          if (db.isTransaction) throw error;
          throw failure('commit_outcome_unknown', `cannot confirm COMMIT: ${error.message}; inspect history before retrying`);
        }
        return null;
      }
      case 'close': this.close(a.id); return null;
      case 'clock': return String(Math.floor(performance.now()));
      case 'timestamp': return new Date().toISOString();
      default: throw failure('input', `unknown host operation ${op}`);
    }
  }

  call(op, json) {
    let event;
    try {
      this.throwIfCancelled();
      const args = JSON.parse(json);
      if (op === 'open_clone') this.stage = 'rehearse';
      if (op === 'exec_script') this.stage = args.id === 'source' ? 'apply' : 'rehearse';
      if (['load', 'begin', 'open_clone', 'exec_script', 'exec_check', 'validate', 'commit'].includes(op)) {
        event = { stage: this.stage, operation: op, ...(args.id ? { connection: args.id } : {}), ...(args.filename ? { filename: args.filename } : {}), ...(args.name ? { check_name: args.name } : {}) };
        this.onProgress({ ...event, state: 'start' });
      }
      this.throwIfCancelled();
      const value = this.dispatch(op, args);
      if (event) this.onProgress({ ...event, state: 'complete' });
      return JSON.stringify({ ok: true, value });
    }
    catch (error) {
      if (event) this.onProgress({ ...event, state: 'failed' });
      if (this.isCancelled() && error.kind !== 'commit_outcome_unknown') {
        return JSON.stringify({ ok: false, kind: 'cancelled', message: 'migration cancelled at a safe operation boundary; active transaction will be rolled back' });
      }
      const busy = error.errcode === 5 || error.errcode === 6 || /database is (locked|busy)/i.test(error.message);
      const kind = error.kind ?? (busy ? 'lock_timeout' : error.errcode !== undefined ? 'database' : error instanceof TypeError || error.code?.startsWith('E') ? 'input' : 'database');
      return JSON.stringify({ ok: false, kind, message: error.message });
    }
  }

  async makeBackup(command) {
    this.stage = 'backup';
    this.temp = mkdtempSync(join(tmpdir(), 'moonmolt-'));
    if (command === 'apply') {
      this.persistentBackup = true;
      const folder = this.backupDir ?? `${this.sourcePath}.moonmolt-backups`;
      mkdirSync(folder, { recursive: true });
      this.backupPath = join(folder, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.sqlite`);
    } else this.backupPath = join(this.temp, 'before.sqlite');
    const reader = new DatabaseSync(this.sourcePath, { readOnly: true });
    this.onProgress({ stage: 'backup', operation: 'backup', state: 'start', backup: this.backupPath });
    try {
      await backup(reader, this.backupPath, { progress: ({ remainingPages, totalPages }) => {
        this.onProgress({ stage: 'backup', operation: 'backup', state: 'progress', remaining_pages: remainingPages, total_pages: totalPages });
      } });
      this.backupComplete = true;
      this.onProgress({ stage: 'backup', operation: 'backup', state: 'complete', backup: this.backupPath });
    }
    finally { reader.close(); }
    this.clonePath = join(this.temp, 'rehearsal.sqlite');
    copyFileSync(this.backupPath, this.clonePath);
  }

  close(id) {
    const connection = this.connections.get(id);
    if (!connection) return;
    try {
      if (connection.db.isTransaction) connection.db.exec('ROLLBACK;');
      if (!connection.read_only) connection.db.exec('PRAGMA foreign_keys=ON;');
    } finally { connection.db.close(); this.connections.delete(id); }
  }

  cleanup() {
    const errors = [];
    for (const id of [...this.connections.keys()]) { try { this.close(id); } catch (e) { errors.push(e.message); } }
    if (this.temp) { try { rmSync(this.temp, { recursive: true, force: true }); } catch (e) { errors.push(e.message); } }
    return errors;
  }

  saveReport(report) {
    if (!this.backupPath || !this.persistentBackup) return null;
    const reportPath = `${this.backupPath}.json`;
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    return reportPath;
  }
}
