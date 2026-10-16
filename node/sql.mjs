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

/** Read only the INSTEAD OF event from SQLite-accepted view trigger headers.
 * Quoted names and comments are skipped; the trigger body is never parsed.
 */
export function viewTriggerEvent(sql) {
  if (typeof sql !== 'string') return undefined;
  let offset = 0;
  const recent = [];
  while (offset < sql.length) {
    offset += skipTrivia(sql.slice(offset));
    if (offset === sql.length) break;
    let token = null;
    const ch = sql[offset];
    if (['"', "'", '`', '['].includes(ch)) {
      const close = ch === '[' ? ']' : ch;
      offset++;
      while (offset < sql.length) {
        if (sql[offset] !== close) { offset++; continue; }
        if (close !== ']' && sql[offset + 1] === close) { offset += 2; continue; }
        offset++; break;
      }
    } else {
      const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(offset));
      token = word ? word[0].toUpperCase() : ch;
      offset += word ? word[0].length : 1;
    }
    recent.push(token);
    if (recent.length > 3) recent.shift();
    if (recent[0] === 'INSTEAD' && recent[1] === 'OF' && ['INSERT', 'UPDATE', 'DELETE'].includes(recent[2])) return recent[2];
  }
  return undefined;
}

/** Compile against the preceding statements' schema; never split at semicolons. */
export function executeScript(db, sql, checkpoint, afterStatement = () => {}) {
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
    afterStatement();
    remaining = remaining.slice(compiled.length);
  }
}
