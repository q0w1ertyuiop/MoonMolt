import { DatabaseSync, backup, constants as C } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync, realpathSync, mkdirSync, mkdtempSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const HISTORY = '__moonmigrate_history';
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

  constructor() {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 24 || (major === 24 && minor < 10)) throw failure('input', 'MoonMolt requires Node.js >=24.10.0');
    if (typeof DatabaseSync.prototype.setAuthorizer !== 'function' || typeof backup !== 'function') throw failure('input', 'node:sqlite authorizer and backup APIs are required');
  }

  db(id) {
    const connection = this.connections.get(id);
    if (!connection) throw failure('database', `connection ${id} is not open`);
    return connection.db;
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
    db.exec('PRAGMA busy_timeout=5000;');
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
    return { objects, tables, fingerprint: hash(JSON.stringify(objects)), sqlite_version: this.query(id, 'SELECT sqlite_version() AS version')[0].version };
  }

  history(id) {
    if (!this.query(id, 'SELECT name FROM sqlite_schema WHERE name=?', HISTORY).length) return [];
    const ddl = this.query(id, 'SELECT sql FROM sqlite_schema WHERE name=?', HISTORY)[0].sql;
    if (!ddl || !this.query(id, `PRAGMA table_info(${quote(HISTORY)})`).some(c => c.name === 'version' && c.pk === 1)) throw failure('policy', 'invalid migration history table');
    return this.query(id, `SELECT version,name,checksum,applied_at,CAST(duration_ms AS TEXT) AS duration_ms,schema_before,schema_after,tool_version FROM ${quote(HISTORY)} ORDER BY version`);
  }

  script(id, sql, filename) {
    const db = this.db(id);
    if (!db.isTransaction) throw failure('policy', 'migration requires an active engine transaction');
    let denied = null;
    const controls = new Set([C.SQLITE_TRANSACTION, C.SQLITE_SAVEPOINT, C.SQLITE_ATTACH, C.SQLITE_DETACH, C.SQLITE_PRAGMA]);
    db.setAuthorizer((action, a, b, database) => {
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
    catch (error) { throw denied ? failure('policy', `${filename}: ${denied}`) : Object.assign(error, { message: `${filename}: ${error.message}` }); }
    finally { db.setAuthorizer(null); }
    if (!db.isTransaction) throw failure('policy', `${filename}: transaction ended unexpectedly`);
  }

  dispatch(op, a) {
    switch (op) {
      case 'load': return readdirSync(a.dir, { withFileTypes: true }).filter(f => f.name.endsWith('.sql')).map(f => {
        if (!f.isFile()) throw failure('input', `migration must be a regular file: ${f.name}`);
        const bytes = readFileSync(join(a.dir, f.name));
        const sql = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        if (sql.includes('\0')) throw failure('input', `NUL byte in ${f.name}`);
        return { filename: f.name, checksum: hash(bytes), sql };
      });
      case 'open': return this.open(a);
      case 'open_clone': this.stage = 'rehearse'; return this.open({ id: 'clone', path: this.clonePath, rebuild: a.rebuild });
      case 'begin': this.db(a.id).exec('BEGIN IMMEDIATE;'); return null;
      case 'history': return this.history(a.id);
      case 'inspect': return this.inspect(a.id);
      case 'fingerprint': return this.inspect(a.id).fingerprint;
      case 'history_init': this.db(a.id).exec(`CREATE TABLE IF NOT EXISTS ${quote(HISTORY)} (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL, duration_ms INTEGER NOT NULL, schema_before TEXT NOT NULL, schema_after TEXT NOT NULL, tool_version TEXT NOT NULL);`); return null;
      case 'exec_script': this.stage = a.id === 'source' ? 'apply' : 'rehearse'; this.script(a.id, a.sql, a.filename); return null;
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
    try { return JSON.stringify({ ok: true, value: this.dispatch(op, JSON.parse(json)) }); }
    catch (error) {
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
      const folder = `${this.sourcePath}.moonmolt-backups`;
      mkdirSync(folder, { recursive: true });
      this.backupPath = join(folder, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.sqlite`);
    } else this.backupPath = join(this.temp, 'before.sqlite');
    const reader = new DatabaseSync(this.sourcePath, { readOnly: true });
    try { await backup(reader, this.backupPath); this.backupComplete = true; }
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
