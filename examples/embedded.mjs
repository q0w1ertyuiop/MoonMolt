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
  // Demo review step: this file was just created above. In deployment, retain a
  // fingerprint from an earlier trusted schema review, not an unknown live file.
  const reviewed = await runInWorker({ command: 'inspect', db, expected_application_id: applicationId });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
  const expected_fingerprint = reviewed.snapshot.fingerprint;
  const result = await runInWorker({ command: 'apply', db, migrations, expected_application_id: applicationId, expected_version: 0, expected_fingerprint });
  assert.equal(result.ok, true, JSON.stringify(result));
  const stale = await runInWorker({ command: 'apply', db, migrations, expected_application_id: applicationId, expected_version: 0 });
  assert.equal(stale.kind, 'policy');
  const staleSchema = await runInWorker({ command: 'apply', db, migrations, expected_application_id: applicationId, expected_fingerprint });
  assert.equal(staleSchema.kind, 'policy');
  assert.match(staleSchema.message, /fingerprint mismatch/);
  const status = await runInWorker({ command: 'status', db, migrations, expected_application_id: applicationId });
  assert.equal(status.current_version, 3);
  assert.notEqual(status.fingerprint, expected_fingerprint);
  // Here the successful upgrade established the new trusted schema. Do not
  // automatically refresh a rejected expectation and retry an unknown database.
  assert.equal(status.fingerprint, result.result.fingerprint);
  const repeat = await runInWorker({ command: 'apply', db, migrations, expected_application_id: applicationId, expected_version: status.current_version, expected_fingerprint: result.result.fingerprint });
  assert.equal(repeat.noop, true);
  const reader = new DatabaseSync(db, { readOnly: true });
  let note;
  try { note = { ...reader.prepare('SELECT * FROM notes').get() }; } finally { reader.close(); }
  assert.deepEqual(note, { id: 1, body: '保留这条笔记', pinned: 0 });
  console.log(JSON.stringify({ application_id: applicationId, current_version: status.current_version, fingerprint: status.fingerprint, checks: result.result.checks, stale_request: stale.kind, stale_schema: staleSchema.kind, repeat_noop: repeat.noop, note }, null, 2));
} finally {
  assert.equal(root.startsWith(join(tmpdir(), 'moonmolt-embedded-demo-')), true);
  rmSync(root, { recursive: true, force: true });
}
