import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { runInWorker } from '../node/runtime.mjs';

// These strings can live in an application's bundle, with no migrations directory.
const migrations = [
  { filename: '000001_notes.sql', sql: "CREATE TABLE notes(id INTEGER PRIMARY KEY,body TEXT NOT NULL); INSERT INTO notes VALUES(1,'保留这条笔记');" },
  { filename: '000003_pinned.sql', sql: 'ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;',
    checks_json: '{"checks":[{"name":"original note retained","sql":"SELECT COUNT(*)=1 AND MIN(body)=\'保留这条笔记\' AND MAX(pinned)=0 FROM notes;"}]}' },
];
const root = mkdtempSync(join(tmpdir(), 'moonmolt-embedded-demo-')), db = join(root, 'notes.db');
const applicationId = 0x4d4f4c54;
try {
  // The application sets the identity only while creating its own brand-new file.
  // Never assign it to an arbitrary existing database to bypass a mismatch.
  const fresh = new DatabaseSync(db);
  try { fresh.exec(`PRAGMA application_id=${applicationId};`); } finally { fresh.close(); }
  const result = await runInWorker({ command: 'apply', db, migrations, expected_application_id: applicationId, expected_version: 0 });
  assert.equal(result.ok, true, JSON.stringify(result));
  const stale = await runInWorker({ command: 'apply', db, migrations, expected_application_id: applicationId, expected_version: 0 });
  assert.equal(stale.kind, 'policy');
  const status = await runInWorker({ command: 'status', db, migrations, expected_application_id: applicationId });
  assert.equal(status.current_version, 3);
  const repeat = await runInWorker({ command: 'apply', db, migrations, expected_application_id: applicationId, expected_version: status.current_version });
  assert.equal(repeat.noop, true);
  const reader = new DatabaseSync(db, { readOnly: true });
  let note;
  try { note = { ...reader.prepare('SELECT * FROM notes').get() }; } finally { reader.close(); }
  assert.deepEqual(note, { id: 1, body: '保留这条笔记', pinned: 0 });
  console.log(JSON.stringify({ application_id: applicationId, current_version: status.current_version, checks: result.result.checks, stale_request: stale.kind, repeat_noop: repeat.noop, note }, null, 2));
} finally {
  assert.equal(root.startsWith(join(tmpdir(), 'moonmolt-embedded-demo-')), true);
  rmSync(root, { recursive: true, force: true });
}
