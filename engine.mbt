///|
fn[T : @json.FromJson] decode(value : Json) -> T raise MigrationError {
  @json.from_json(value) catch {
    e => raise Database("host returned an invalid operation result: \{e}")
  }
}

///|
pub fn inspect(
  driver : &Driver,
  id : String,
) -> SchemaSnapshot raise MigrationError {
  decode(driver.call("inspect", { "id": ToJson::to_json(id) }))
}

///|
pub fn status(
  driver : &Driver,
  migrations : Array[Migration],
  id : String,
  to : Int?,
) -> Json raise MigrationError {
  let history : Array[HistoryEntry] = decode(
    driver.call("history", { "id": ToJson::to_json(id) }),
  )
  let pending = pending_migrations(migrations, history, to)
  let fingerprint : String = decode(
    driver.call("fingerprint", { "id": ToJson::to_json(id) }),
  )
  check_drift(fingerprint, history)
  {
    "ok": true,
    "applied": ToJson::to_json(history),
    "pending": ToJson::to_json(pending.map(m => m.filename)),
    "fingerprint": ToJson::to_json(fingerprint),
  }
}

///|
fn check_drift(
  actual : String,
  history : Array[HistoryEntry],
) -> Unit raise MigrationError {
  if !history.is_empty() {
    guard actual == history[history.length() - 1].schema_after else {
      raise HistoryMismatch("database schema changed outside migration history")
    }
  }
}

///|
fn check_expected_fingerprint(
  actual : String,
  expected : String?,
) -> Unit raise MigrationError {
  if expected is Some(expected) {
    guard actual == expected else {
      raise Policy(
        "schema fingerprint mismatch: expected \{expected}, found \{actual}",
      )
    }
  }
}

///|
pub fn prepare(
  driver : &Driver,
  request : Request,
) -> Prepared raise MigrationError {
  guard request.command == "inspect" ||
    request.command == "status" ||
    request.command == "verify" ||
    request.command == "rehearse" ||
    request.command == "apply" else {
    raise Input("unknown command \{request.command}")
  }
  if request.expected_fingerprint is Some(expected) {
    guard expected.length() == 64 else {
      raise Input(
        "expected_fingerprint must be 64 lowercase hexadecimal characters",
      )
    }
    for ch in expected {
      guard (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') else {
        raise Input(
          "expected_fingerprint must be 64 lowercase hexadecimal characters",
        )
      }
    }
  }
  if request.command == "verify" {
    guard request.to is None && !request.rebuild && !request.create else {
      raise Input("verify does not accept to, rebuild or create")
    }
  }
  if request.verify_checks is Some(checks) {
    guard request.command == "verify" else {
      raise Input("verify_checks only applies to verify")
    }
    validate_check_group(checks, "verify_checks", [])
  }
  if request.expected_version is Some(version) {
    guard request.command != "inspect" && version >= 0 && version <= 999999 else {
      raise Input(
        "expected_version requires a migration command and a version between 0 and 999999",
      )
    }
  }
  let migrations = if request.command == "inspect" {
    []
  } else {
    let sources : Array[MigrationSource] = decode(
      driver.call("load", { "dir": ToJson::to_json(request.dir) }),
    )
    load_migrations(sources)
  }
  ignore(
    driver.call("open", {
      "id": "source",
      "path": ToJson::to_json(request.db),
      "read_only": ToJson::to_json(request.command != "apply"),
      "create": ToJson::to_json(request.create && request.command == "apply"),
      "rebuild": ToJson::to_json(request.rebuild),
    }),
  )
  if request.command == "apply" {
    ignore(driver.call("begin", { "id": "source" }))
  } else {
    ignore(driver.call("begin_read", { "id": "source" }))
  }
  let application_id : Int = decode(
    driver.call("application_id", { "id": "source" }),
  )
  if request.expected_application_id is Some(expected) {
    guard application_id == expected else {
      raise Policy(
        "application_id mismatch: expected \{expected}, found \{application_id}",
      )
    }
  }
  if request.command == "inspect" {
    let snapshot = inspect(driver, "source")
    check_expected_fingerprint(
      snapshot.fingerprint,
      request.expected_fingerprint,
    )
    return {
      request,
      pending: [],
      backup_required: false,
      report: { "ok": true, "snapshot": ToJson::to_json(snapshot) },
      fingerprint: "",
      history: [],
      application_id,
    }
  }
  let history : Array[HistoryEntry] = decode(
    driver.call("history", { "id": "source" }),
  )
  let current_version = if history.is_empty() {
    0
  } else {
    history[history.length() - 1].version
  }
  if request.expected_version is Some(expected) {
    guard current_version == expected else {
      raise Policy(
        "migration version mismatch: expected \{expected}, found \{current_version}",
      )
    }
  }
  let pending = pending_migrations(migrations, history, request.to)
  let fingerprint : String = decode(
    driver.call("fingerprint", { "id": "source" }),
  )
  check_drift(fingerprint, history)
  check_expected_fingerprint(fingerprint, request.expected_fingerprint)
  let report : Json = if request.command == "verify" {
    let validation = driver.call("verify", { "id": "source" })
    guard validation
      is { "integrity_check": "ok", "foreign_key_check": "ok", .. } else {
      raise Database("host returned invalid verification results")
    }
    let checks : Array[Json] = []
    if request.verify_checks is Some(queries) {
      for check in queries {
        ignore(
          driver.call("exec_check", {
            "id": "source",
            "sql": ToJson::to_json(check.sql),
            "name": ToJson::to_json(check.name),
            "filename": "verify",
          }),
        )
        checks.push({ "name": ToJson::to_json(check.name), "ok": true })
      }
    }
    {
      "ok": true,
      "command": "verify",
      "verified": true,
      "database_modified": false,
      "applied": ToJson::to_json(history),
      "pending": ToJson::to_json(pending.map(m => m.filename)),
      "current_version": ToJson::to_json(current_version),
      "application_id": ToJson::to_json(application_id),
      "validation": validation,
      "checks": ToJson::to_json(checks),
      "fingerprint": ToJson::to_json(fingerprint),
    }
  } else {
    {
      "ok": true,
      "command": ToJson::to_json(request.command),
      "applied": ToJson::to_json(history),
      "pending": ToJson::to_json(pending.map(m => m.filename)),
      "noop": ToJson::to_json(pending.is_empty()),
      "current_version": ToJson::to_json(current_version),
      "application_id": ToJson::to_json(application_id),
      "fingerprint": ToJson::to_json(fingerprint),
    }
  }
  if request.command == "rehearse" {
    ignore(driver.call("close", { "id": "source" }))
  }
  {
    request,
    pending,
    backup_required: (
      request.command == "apply" || request.command == "rehearse"
    ) &&
    !pending.is_empty(),
    report,
    fingerprint,
    history,
    application_id,
  }
}

///|
fn apply_batch(
  driver : &Driver,
  id : String,
  migrations : Array[Migration],
) -> Json raise MigrationError {
  ignore(driver.call("history_init", { "id": ToJson::to_json(id) }))
  let applied : Array[HistoryEntry] = []
  let verified : Array[Json] = []
  let preserved : Array[Json] = []
  for migration in migrations {
    let sequences : Array[SequenceState] = decode(
      driver.call("sequences", { "id": ToJson::to_json(id) }),
    )
    let before : String = decode(
      driver.call("fingerprint", { "id": ToJson::to_json(id) }),
    )
    let start : Int64 = decode(driver.call("clock", {}))
    let baseline = capture_preserved(driver, id, migration)
    ignore(
      driver.call("exec_script", {
        "id": ToJson::to_json(id),
        "sql": ToJson::to_json(migration.sql),
        "filename": ToJson::to_json(migration.filename),
      }),
    )
    let updated : Array[SequenceState] = decode(
      driver.call("sequences", { "id": ToJson::to_json(id) }),
    )
    for previous in sequences {
      if previous.seq is Some(floor) {
        for current in updated {
          if current.name.to_lower() == previous.name.to_lower() {
            guard (match current.seq {
              Some(value) => value >= floor
              None => false
            }) else {
              raise Policy(
                "\{migration.filename}: AUTOINCREMENT high-water mark lost for \{previous.name}; preserve sqlite_sequence explicitly before inserting new rows",
              )
            }
          }
        }
      }
    }
    if migration.checks is Some(checks) {
      for check in checks {
        ignore(
          driver.call("exec_check", {
            "id": ToJson::to_json(id),
            "sql": ToJson::to_json(check.sql),
            "name": ToJson::to_json(check.name),
            "filename": ToJson::to_json(migration.filename),
          }),
        )
        verified.push({
          "version": ToJson::to_json(migration.version),
          "filename": ToJson::to_json(migration.filename),
          "name": ToJson::to_json(check.name),
          "ok": true,
        })
      }
    }
    for entry in verify_preserved(driver, id, migration, baseline) {
      preserved.push(entry)
    }
    let after : String = decode(
      driver.call("fingerprint", { "id": ToJson::to_json(id) }),
    )
    let finish : Int64 = decode(driver.call("clock", {}))
    let stamp : String = decode(driver.call("timestamp", {}))
    let entry : HistoryEntry = {
      version: migration.version,
      name: migration.name,
      checksum: migration.checksum,
      applied_at: stamp,
      duration_ms: finish - start,
      schema_before: before,
      schema_after: after,
      tool_version: "0.9.1",
    }
    ignore(
      driver.call("history_insert", {
        "id": ToJson::to_json(id),
        "entry": ToJson::to_json(entry),
      }),
    )
    applied.push(entry)
  }
  ignore(driver.call("validate", { "id": ToJson::to_json(id) }))
  let fingerprint = driver.call("fingerprint", { "id": ToJson::to_json(id) })
  {
    "applied": ToJson::to_json(applied),
    "fingerprint": fingerprint,
    "checks": ToJson::to_json(verified),
    "preserved": ToJson::to_json(preserved),
  }
}

///|
/// Complete a prepared operation after the host has made a backup and clone.
/// The immutable SQL loaded during preparation is used in both databases.
pub fn complete(
  driver : &Driver,
  prepared : Prepared,
) -> Json raise MigrationError {
  if !prepared.backup_required {
    return prepared.report
  }
  ignore(
    driver.call("open_clone", {
      "rebuild": ToJson::to_json(prepared.request.rebuild),
    }),
  )
  ignore(driver.call("begin", { "id": "clone" }))
  let cloned_application_id : Int = decode(
    driver.call("application_id", { "id": "clone" }),
  )
  guard cloned_application_id == prepared.application_id else {
    raise HistoryMismatch(
      "database application_id changed while preparing the rehearsal snapshot",
    )
  }
  let cloned : String = decode(driver.call("fingerprint", { "id": "clone" }))
  guard cloned == prepared.fingerprint else {
    raise HistoryMismatch(
      "database schema changed while preparing the rehearsal snapshot",
    )
  }
  let cloned_history : Array[HistoryEntry] = decode(
    driver.call("history", { "id": "clone" }),
  )
  guard cloned_history == prepared.history else {
    raise HistoryMismatch(
      "migration history changed while preparing the rehearsal snapshot",
    )
  }
  let rehearsal = apply_batch(driver, "clone", prepared.pending)
  ignore(driver.call("commit", { "id": "clone" }))
  ignore(driver.call("close", { "id": "clone" }))
  if prepared.request.command == "rehearse" {
    return {
      "ok": true,
      "command": "rehearse",
      "rehearsal": rehearsal,
      "database_modified": false,
    }
  }
  let result = apply_batch(driver, "source", prepared.pending)
  guard (match (result, rehearsal) {
    ({ "fingerprint": actual, .. }, { "fingerprint": expected, .. }) =>
      actual == expected
    _ => false
  }) else {
    raise Policy("actual schema differs from rehearsal")
  }
  ignore(driver.call("commit", { "id": "source" }))
  {
    "ok": true,
    "command": "apply",
    "result": result,
    "rehearsed": true,
    "noop": false,
  }
}
