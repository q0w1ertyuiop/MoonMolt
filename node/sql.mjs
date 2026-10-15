// Skip only SQLite's leading whitespace, empty terminators and comments.
// Actual statement boundaries (including complete trigger bodies) come from SQLite.
function skipTrivia(sql) {
  let offset = 0;
  while (offset < sql.length) {
    const code = sql.charCodeAt(offset);
    if ([9, 10, 12, 13, 32, 0xfeff].includes(code) || sql[offset] === ';') { offset++; continue; }
    if (sql.startsWith('--', offset)) {
      const end = sql.indexOf('\n', offset + 2);
      offset = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith('/*', offset)) {
      const end = sql.indexOf('*/', offset + 2);
      offset = end < 0 ? sql.length : end + 2;
      continue;
    }
    break;
  }
  return offset;
}

/** Compile against the preceding statements' schema; never split at semicolons. */
export function executeScript(db, sql, checkpoint) {
  let remaining = sql;
  for (;;) {
    checkpoint();
    remaining = remaining.slice(skipTrivia(remaining));
    if (!remaining) return;
    const statement = db.prepare(remaining);
    const compiled = statement.sourceSQL;
    if (!compiled || !remaining.startsWith(compiled)) throw Object.assign(new Error('cannot determine SQLite statement boundary'), { kind: 'policy' });
    if (statement.expandedSQL !== compiled) throw Object.assign(new Error('parameters are not supported in migration scripts; use complete SQL'), { kind: 'policy' });
    // exec consumes all result rows, preserving RETURNING and SELECT behavior.
    // The authorizer stays installed during compilation and execution.
    db.exec(compiled);
    if (!db.isTransaction) throw Object.assign(new Error('transaction ended unexpectedly'), { kind: 'policy' });
    remaining = remaining.slice(compiled.length);
  }
}
