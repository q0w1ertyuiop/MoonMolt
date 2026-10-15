import { createHash } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const decodeUtf8 = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);

function checkGroups(document, label, allowed = ['checks', 'preserve']) {
  if (!document || Array.isArray(document) || !Object.keys(document).length || Object.keys(document).some(key => !allowed.includes(key))) {
    throw new Error(`${label}: expected ${allowed.join(' and/or ')} arrays`);
  }
  const names = new Set();
  for (const [group, queries] of Object.entries(document)) {
    if (!Array.isArray(queries) || !queries.length) throw new Error(`${label}: ${group} must be a nonempty array`);
    for (const check of queries) {
      if (!check || Array.isArray(check) || Object.keys(check).some(key => !['name', 'sql'].includes(key)) || typeof check.name !== 'string' || !check.name.trim() || typeof check.sql !== 'string' || !check.sql.trim() || check.sql.includes('\0') || names.has(check.name)) {
        throw new Error(`${label}: checks and preserve require unique names and nonempty SQL, with no unknown fields`);
      }
      for (const value of [check.name, check.sql]) {
        if (Buffer.from(value, 'utf8').toString('utf8') !== value) throw new Error(`${label}: check names and SQL must be valid Unicode strings`);
      }
      names.add(check.name);
    }
  }
}

/** Capture only explicit verification queries; never replay historical checks. */
export function captureVerificationChecks(checks) {
  // Read each caller-owned field once before validating or crossing a queue.
  if (!Array.isArray(checks)) throw new Error('verify_checks must be a nonempty array');
  const snapshot = checks.map(check => {
    if (!check || typeof check !== 'object' || Array.isArray(check) || Object.keys(check).some(key => !['name', 'sql'].includes(key))) throw new Error('verify_checks require name and sql only');
    return Object.freeze({ name: check.name, sql: check.sql });
  });
  checkGroups({ checks: snapshot }, 'verify_checks', ['checks']);
  return Object.freeze(snapshot);
}

export function parseVerificationChecks(bytes) {
  let document;
  try { document = JSON.parse(decodeUtf8(bytes).replace(/^\uFEFF/, '')); }
  catch { throw new Error('invalid UTF-8 verification checks document'); }
  checkGroups(document, 'verification document', ['checks']);
  return captureVerificationChecks(document.checks);
}

export function migrationSource(filename, bytes, checksBytes) {
  const sql = decodeUtf8(bytes);
  if (sql.includes('\0')) throw new Error(`NUL byte in ${filename}`);
  if (checksBytes === undefined) return { filename, checksum: hash(bytes), sql };
  let document;
  try { document = JSON.parse(decodeUtf8(checksBytes).replace(/^\uFEFF/, '')); }
  catch { throw new Error(`${filename}: invalid UTF-8 JSON checks document`); }
  checkGroups(document, filename);
  return { filename, sql, ...document, checksum: hash(`moonmolt-checks-v1\0${hash(bytes)}\0${hash(checksBytes)}`) };
}

/** Snapshot strings only: no caller-supplied checksums, functions or mutable checks. */
export function captureMigrations(migrations) {
  if (!Array.isArray(migrations)) throw new Error('migrations must be an array');
  const result = [];
  for (const entry of migrations) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['filename', 'sql', 'checks_json'].includes(key))) {
      throw new Error('each migration requires filename, sql and optional checks_json only');
    }
    const { filename, sql, checks_json } = entry;
    if (typeof filename !== 'string' || !/^[0-9]{6}_[A-Za-z0-9_-]+\.sql$/.test(filename) || !filename.endsWith('.sql') || filename.startsWith('000000_')) throw new Error('expected a positive 000001_name.sql filename');
    for (const [name, value] of [['sql', sql], ['checks_json', checks_json]]) {
      if (name === 'checks_json' && value === undefined) continue;
      if (typeof value !== 'string' || Buffer.from(value, 'utf8').toString('utf8') !== value) throw new Error(`${filename}: ${name} must be a valid Unicode string`);
    }
    // Validate before a worker starts or an apply --create can create a file.
    migrationSource(filename, Buffer.from(sql), checks_json === undefined ? undefined : Buffer.from(checks_json));
    result.push(Object.freeze({ filename, sql, ...(checks_json === undefined ? {} : { checks_json }) }));
  }
  const versions = result.map(entry => entry.filename.slice(0, 6));
  if (new Set(versions).size !== versions.length) throw new Error('duplicate migration version');
  return Object.freeze(result);
}
