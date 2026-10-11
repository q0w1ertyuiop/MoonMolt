///|
fn[T : @json.FromJson] decode(value : Json) -> T raise MigrationError {
  @json.from_json(value) catch {
    _ => raise Database("host returned an invalid operation result")
  }
}

///|
pub fn inspect(driver : &Driver, id : String) -> Json raise MigrationError {
  driver.call("inspect", { "id": id.to_json() })
}

///|
pub fn status(
  driver : &Driver,
  migrations : Array[Migration],
  id : String,
  to : Int?,
) -> Json raise MigrationError {
  let history : Array[HistoryEntry] = decode(
    driver.call("history", { "id": id.to_json() }),
  )
  let pending = pending_migrations(migrations, history, to)
  check_drift(driver, id, history)
  {
    "ok": true,
    "applied": history.to_json(),
    "pending": pending.map(m => m.filename).to_json(),
  }
}

///|
fn check_drift(
  driver : &Driver,
  id : String,
  history : Array[HistoryEntry],
) -> Unit raise MigrationError {
  if !history.is_empty() {
    let actual : String = decode(
      driver.call("fingerprint", { "id": id.to_json() }),
    )
    guard actual == history[history.length() - 1].schema_after else {
      raise HistoryMismatch("database schema changed outside migration history")
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
    request.command == "rehearse" ||
    request.command == "apply" else {
    raise Input("unknown command \{request.command}")
  }
  let migrations = if request.command == "inspect" {
    []
  } else {
    let sources : Array[MigrationSource] = decode(
      driver.call("load", { "dir": request.dir.to_json() }),
    )
    load_migrations(sources)
  }
  ignore(
    driver.call("open", {
      "id": "source",
      "path": request.db.to_json(),
      "read_only": (request.command != "apply").to_json(),
      "create": (request.create && request.command == "apply").to_json(),
      "rebuild": request.rebuild.to_json(),
    }),
  )
  if request.command == "inspect" {
    return {
      request,
      pending: [],
      backup_required: false,
      report: { "ok": true, "snapshot": inspect(driver, "source") },
    }
  }
  if request.command == "apply" {
    ignore(driver.call("begin", { "id": "source" }))
  }
  let history : Array[HistoryEntry] = decode(
    driver.call("history", { "id": "source" }),
  )
  let pending = pending_migrations(migrations, history, request.to)
  check_drift(driver, "source", history)
  let report : Json = {
    "ok": true,
    "command": request.command.to_json(),
    "applied": history.to_json(),
    "pending": pending.map(m => m.filename).to_json(),
    "noop": pending.is_empty().to_json(),
  }
  {
    request,
    pending,
    backup_required: request.command != "status" && !pending.is_empty(),
    report,
  }
}

///|
fn apply_batch(
  driver : &Driver,
  id : String,
  migrations : Array[Migration],
) -> Json raise MigrationError {
  ignore(driver.call("history_init", { "id": id.to_json() }))
  let applied : Array[HistoryEntry] = []
  for migration in migrations {
    let before : String = decode(
      driver.call("fingerprint", { "id": id.to_json() }),
    )
    let start : Int = decode(driver.call("clock", {}))
    ignore(
      driver.call("exec_script", {
        "id": id.to_json(),
        "sql": migration.sql.to_json(),
        "filename": migration.filename.to_json(),
      }),
    )
    let after : String = decode(
      driver.call("fingerprint", { "id": id.to_json() }),
    )
    let finish : Int = decode(driver.call("clock", {}))
    let stamp : String = decode(driver.call("timestamp", {}))
    let entry : HistoryEntry = {
      version: migration.version,
      name: migration.name,
      checksum: migration.checksum,
      applied_at: stamp,
      duration_ms: finish - start,
      schema_before: before,
      schema_after: after,
      tool_version: "0.1.0",
    }
    ignore(
      driver.call("history_insert", {
        "id": id.to_json(),
        "entry": ToJson::to_json(entry),
      }),
    )
    applied.push(entry)
  }
  ignore(driver.call("validate", { "id": id.to_json() }))
  let fingerprint = driver.call("fingerprint", { "id": id.to_json() })
  { "applied": applied.to_json(), "fingerprint": fingerprint }
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
    driver.call("open_clone", { "rebuild": prepared.request.rebuild.to_json() }),
  )
  ignore(driver.call("begin", { "id": "clone" }))
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
