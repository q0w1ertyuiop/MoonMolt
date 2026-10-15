import { resolve } from 'node:path';
import { captureMigrations } from './migrations.mjs';

/** Capture primitive request values before queueing or crossing a worker boundary. */
export function captureRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('request must be an object');
  const { command = 'status', db, dir, migrations, rebuild = false, create = false, to, busy_timeout_ms = 5000, backup_dir, expected_application_id, expected_version } = request;
  if (!['inspect', 'status', 'verify', 'rehearse', 'apply'].includes(command)) throw new Error('unknown command');
  if (typeof db !== 'string' || !db.trim()) throw new Error('db must be a nonempty file path');
  if (dir !== undefined && (typeof dir !== 'string' || !dir.trim())) throw new Error('dir must be a nonempty directory path');
  if (migrations !== undefined && (dir !== undefined || command === 'inspect')) throw new Error('migrations cannot be combined with dir or inspect');
  if (expected_application_id !== undefined && (!Number.isInteger(expected_application_id) || expected_application_id < -2147483648 || expected_application_id > 2147483647)) throw new Error('expected_application_id must be a signed 32-bit integer');
  if (expected_version !== undefined && (command === 'inspect' || !Number.isInteger(expected_version) || expected_version < 0 || expected_version > 999999)) throw new Error('expected_version requires status, verify, rehearse or apply and an integer between 0 and 999999');
  if (typeof rebuild !== 'boolean' || typeof create !== 'boolean') throw new Error('rebuild and create must be booleans');
  if (create && command !== 'apply') throw new Error('create only applies to apply');
  if (command === 'inspect' && (to != null || rebuild)) throw new Error('to and rebuild do not apply to inspect');
  if (command === 'verify' && (to != null || rebuild)) throw new Error('to and rebuild do not apply to verify');
  if (to != null && (!Number.isInteger(to) || to <= 0 || to > 999999)) throw new Error('target version must be an integer between 1 and 999999');
  if (!Number.isInteger(busy_timeout_ms) || busy_timeout_ms < 0 || busy_timeout_ms > 2147483647) throw new Error('busy_timeout_ms must be an integer between 0 and 2147483647');
  if (backup_dir !== undefined && (command !== 'apply' || typeof backup_dir !== 'string' || !backup_dir.trim())) throw new Error('backup_dir requires apply and a nonempty directory path');
  return Object.freeze({ command, db: resolve(db), ...(migrations === undefined ? { dir: resolve(dir ?? 'migrations') } : {}), rebuild, create, busy_timeout_ms,
    ...(migrations === undefined ? {} : { migrations: captureMigrations(migrations) }),
    ...(expected_application_id === undefined ? {} : { expected_application_id }),
    ...(expected_version === undefined ? {} : { expected_version }),
    ...(to == null ? {} : { to }), ...(backup_dir === undefined ? {} : { backup_dir: resolve(backup_dir) }) });
}

export const inputFailure = error => ({ ok: false, kind: 'input', exit_code: 1, message: error.message });
