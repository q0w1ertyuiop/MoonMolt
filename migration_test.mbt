///|
fn source(
  filename : String,
  checksum? : String = "sha",
  sql? : String = "SELECT 1;",
) -> @moonmolt.MigrationSource {
  { filename, checksum, sql, checks: None, preserve: None, }
}

///|
test "versions are numeric, gaps are allowed" {
  let migrations = @moonmolt.load_migrations([
    source("000010_later.sql"),
    source("000002_first.sql"),
  ])
  @test.assert_eq(migrations.map(m => m.version), [2, 10])
}

///|
test "bad names and duplicate versions fail" {
  for
    files in [
      [source("000000_zero.sql")],
      [source("1_bad.sql")],
      [source("000001_.sql")],
      [source("000001_a.sql"), source("000001_b.sql")],
    ] {
    try @moonmolt.load_migrations(files) catch {
      _ => ()
    } noraise {
      _ => fail("expected rejection")
    }
  }
}

///|
test "history is an exact immutable prefix" {
  let migrations = @moonmolt.load_migrations([
    source("000001_first.sql"),
    source("000003_next.sql"),
  ])
  let entry : @moonmolt.HistoryEntry = {
    version: 1,
    name: "first",
    checksum: "sha",
    applied_at: "now",
    duration_ms: 0,
    schema_before: "",
    schema_after: "",
    tool_version: "0.1.0",
  }
  @test.assert_eq(
    @moonmolt.pending_migrations(migrations, [entry], None).map(m => m.version),
    [3],
  )
  try
    @moonmolt.validate_history(migrations, [{ ..entry, checksum: "changed", }])
  catch {
    _ => ()
  } noraise {
    _ => fail("expected checksum rejection")
  }
  try @moonmolt.pending_migrations(migrations, [entry], Some(2)) catch {
    _ => ()
  } noraise {
    _ => fail("expected missing target rejection")
  }
}

///|
test "renderer wrappers are removed precisely, not by semicolons" {
  let sql = @moonmolt.unwrap_rendered_sql([
    "PRAGMA foreign_keys=OFF;", "BEGIN IMMEDIATE;", "INSERT INTO t VALUES ('a;b');",
    "COMMIT;", "PRAGMA foreign_keys=ON;",
  ])
  @test.assert_eq(sql, "INSERT INTO t VALUES ('a;b');\n")
  try @moonmolt.unwrap_rendered_sql(["BEGIN EXCLUSIVE;"]) catch {
    _ => ()
  } noraise {
    _ => fail("unknown wrapper must fail")
  }
  try @moonmolt.unwrap_rendered_sql(["PRAGMA foreign_keys=OFF;"]) catch {
    _ => ()
  } noraise {
    _ => fail("incomplete wrapper must fail")
  }
}

///|
test "optional business checks preserve SQL-only inputs and reject duplicate names" {
  let original = source("000001_first.sql")
  @test.assert_eq(@moonmolt.load_migrations([original])[0].checks, None)
  let check : @moonmolt.MigrationCheck = {
    name: "rows intact",
    sql: "SELECT 1;",
  }
  let checked = { ..original, checks: Some([check]), }
  @test.assert_eq(@moonmolt.load_migrations([checked])[0].checks, Some([check]))
  for checks in [[], [check, check]] {
    try
      @moonmolt.load_migrations([{ ..original, checks: Some(checks), }])
    catch {
      _ => ()
    } noraise {
      _ => fail("invalid business checks must fail")
    }
  }
}

///|
test "preservation groups reject empty lists and names shared with ordinary checks" {
  let original = source("000001_first.sql")
  let query : @moonmolt.MigrationCheck = {
    name: "count",
    sql: "SELECT COUNT(*) FROM orders;",
  }
  @test.assert_eq(
    @moonmolt.load_migrations([{ ..original, preserve: Some([query]), }])[0].preserve,
    Some([query]),
  )
  for
    invalid in [
      { ..original, preserve: Some([]), },
      { ..original, preserve: Some([query, query]), },
      { ..original, checks: Some([query]), preserve: Some([query]), },
    ] {
    try @moonmolt.load_migrations([invalid]) catch {
      @moonmolt.Input(_) => ()
      _ => fail("expected invalid verification group")
    } noraise {
      _ => fail("invalid verification must fail")
    }
  }
}

///|
priv struct PreservationDriver {
  calls : Array[String]
  corrupt : Bool
}

///|
impl @moonmolt.Driver for PreservationDriver with fn call(self, op, args) {
  self.calls.push(
    match args {
      { "id": String(id), "phase": String(phase), .. } => "\{op}:\{id}:\{phase}"
      { "id": String(id), .. } => "\{op}:\{id}"
      _ => op
    },
  )
  match op {
    "load" =>
      ToJson::to_json([
        {
          ..source("000001_first.sql"),
          preserve: Some([{ name: "value", sql: "SELECT amount FROM orders;", }]),
        },
      ])
    "history" | "sequences" => []
    "application_id" => 1234
    "fingerprint" => "same"
    "clock" => "0"
    "timestamp" => "now"
    "capture_value" =>
      if self.corrupt && args is { "phase": "after", .. } {
        { "type": "integer", "value": "9007199254740992" }
      } else {
        { "type": "integer", "value": "9007199254740993" }
      }
    _ => Json::null()
  }
}

///|
test "engine compares exact captured values before writing history or committing" {
  let request : @moonmolt.Request = {
    command: "apply",
    db: "app.db",
    dir: "",
    rebuild: false,
    create: false,
    to: None,
    expected_application_id: None,
    expected_version: None,
    expected_fingerprint: None,
    verify_checks: None,
  }
  let good = PreservationDriver::{ calls: [], corrupt: false, }
  let result = @moonmolt.complete(good, @moonmolt.prepare(good, request))
  guard result
    is { "ok": true, "result": { "preserved": Array(items), .. }, .. } else {
    fail("expected successful preservation report")
  }
  @test.assert_eq(items.length(), 1)
  let operations = good.calls.filter(op => {
    op.has_prefix("capture_value") ||
    op.has_prefix("exec_script") ||
    op.has_prefix("history_insert") ||
    op.has_prefix("commit")
  })
  @test.assert_eq(operations, [
    "capture_value:clone:before", "exec_script:clone", "capture_value:clone:after",
    "history_insert:clone", "commit:clone", "capture_value:source:before", "exec_script:source",
    "capture_value:source:after", "history_insert:source", "commit:source",
  ])
  let bad = PreservationDriver::{ calls: [], corrupt: true, }
  try @moonmolt.complete(bad, @moonmolt.prepare(bad, request)) catch {
    @moonmolt.Policy(_) => ()
    _ => fail("expected preservation policy failure")
  } noraise {
    _ => fail("changed value must fail")
  }
  @test.assert_eq(bad.calls.contains("history_insert:clone"), false)
  @test.assert_eq(bad.calls.contains("commit:clone"), false)
  @test.assert_eq(bad.calls.contains("exec_script:source"), false)
}

///|
test "cancellation has a distinct transport category and exit code" {
  let report = @moonmolt.error_json(@moonmolt.Cancelled("requested"))
  @test.assert_eq(report, {
    "ok": false,
    "kind": "cancelled",
    "exit_code": 4,
    "message": "requested",
  })
}

///|
priv struct GuardDriver {
  calls : Array[String]
}

///|
impl @moonmolt.Driver for GuardDriver with fn call(self, op, _args) {
  self.calls.push(op)
  match op {
    "load" | "history" => []
    "application_id" => 1234
    "fingerprint" => "empty"
    _ => Json::null()
  }
}

///|
test "preconditions belong to the MoonBit engine and run after acquiring the lock" {
  let request : @moonmolt.Request = {
    command: "apply",
    db: "app.db",
    dir: "",
    rebuild: false,
    create: false,
    to: None,
    expected_application_id: Some(1234),
    expected_version: Some(0),
    expected_fingerprint: None,
    verify_checks: None,
  }
  let driver = GuardDriver::{ calls: [], }
  let prepared = @moonmolt.prepare(driver, request)
  @test.assert_eq(driver.calls, [
    "load", "open", "begin", "application_id", "history", "fingerprint",
  ])
  @test.assert_eq(prepared.application_id, 1234)
  @test.assert_eq(prepared.backup_required, false)
  for
    invalid in [
      { ..request, expected_application_id: Some(999), },
      { ..request, expected_version: Some(3), },
    ] {
    let rejected = GuardDriver::{ calls: [], }
    try @moonmolt.prepare(rejected, invalid) catch {
      @moonmolt.Policy(_) => ()
      _ => fail("expected a precondition policy failure")
    } noraise {
      _ => fail("precondition must reject even an empty migration set")
    }
    @test.assert_eq(rejected.calls[2], "begin")
    @test.assert_eq(rejected.calls.contains("fingerprint"), false)
  }
}

///|
priv struct VerificationDriver {
  calls : Array[String]
  invalid_result : Bool
}

///|
impl @moonmolt.Driver for VerificationDriver with fn call(self, op, args) {
  self.calls.push(op)
  match op {
    "load" => ToJson::to_json([source("000001_pending.sql")])
    "open" => {
      guard args is { "read_only": true, "create": false, "rebuild": false, .. } else {
        raise @moonmolt.Database("verification must open read-only")
      }
      Json::null()
    }
    "begin_read" => Json::null()
    "application_id" => 321
    "history" => []
    "fingerprint" => "same"
    "exec_check" => {
      guard args
        is { "id": "source", "filename": "verify", "sql": "SELECT 1;", .. } else {
        raise @moonmolt.Policy("current business rule failed")
      }
      Json::null()
    }
    "verify" =>
      if self.invalid_result {
        Json::null()
      } else {
        { "integrity_check": "ok", "foreign_key_check": "ok" }
      }
    _ => raise @moonmolt.Database("unexpected operation \{op}")
  }
}

///|
test "verification is read-only, has no backup despite pending SQL, and checks host results" {
  let request : @moonmolt.Request = {
    command: "verify",
    db: "backup.sqlite",
    dir: "",
    rebuild: false,
    create: false,
    to: None,
    expected_application_id: Some(321),
    expected_version: Some(0),
    expected_fingerprint: None,
    verify_checks: None,
  }
  let driver = VerificationDriver::{ calls: [], invalid_result: false, }
  let prepared = @moonmolt.prepare(driver, request)
  @test.assert_eq(prepared.backup_required, false)
  @test.assert_eq(prepared.pending.length(), 1)
  let report = @moonmolt.complete(driver, prepared)
  guard report
    is { "command": "verify", "verified": true, "database_modified": false, .. } else {
    fail("expected verified report")
  }
  @test.assert_eq(driver.calls, [
    "load", "open", "begin_read", "application_id", "history", "fingerprint", "verify",
  ])
  let bad = VerificationDriver::{ calls: [], invalid_result: true, }
  try @moonmolt.prepare(bad, request) catch {
    @moonmolt.Database(_) => ()
    _ => fail("expected invalid host result")
  } noraise {
    _ => fail("invalid results cannot claim verification")
  }
  for
    invalid in [
      { ..request, create: true, },
      { ..request, rebuild: true, },
      { ..request, to: Some(1), },
    ] {
    let rejected = VerificationDriver::{ calls: [], invalid_result: false, }
    try @moonmolt.prepare(rejected, invalid) catch {
      @moonmolt.Input(_) => ()
      _ => fail("expected invalid verification options")
    } noraise {
      _ => fail("verification options must fail before opening")
    }
    @test.assert_eq(rejected.calls.length(), 0)
  }
}

///|
test "current verification checks follow integrity and fail closed before claiming success" {
  let request : @moonmolt.Request = {
    command: "verify",
    db: "app.db",
    dir: "",
    rebuild: false,
    create: false,
    to: None,
    expected_application_id: None,
    expected_version: None,
    expected_fingerprint: None,
    verify_checks: Some([{ name: "healthy", sql: "SELECT 1;", }]),
  }
  let driver = VerificationDriver::{ calls: [], invalid_result: false, }
  let prepared = @moonmolt.prepare(driver, request)
  @test.assert_eq(prepared.backup_required, false)
  guard prepared.report
    is { "checks": [{ "name": "healthy", "ok": true, .. }], .. } else {
    fail("expected named current verification result")
  }
  @test.assert_eq(driver.calls[driver.calls.length() - 2:], [
    "verify", "exec_check",
  ])
  let bad = VerificationDriver::{ calls: [], invalid_result: false, }
  try
    @moonmolt.prepare(bad, {
      ..request,
      verify_checks: Some([{ name: "bad", sql: "SELECT 0;", }]),
    })
  catch {
    @moonmolt.Policy(_) => ()
    _ => fail("expected business policy failure")
  } noraise {
    _ => fail("failed current rule cannot verify")
  }
  for
    invalid in [
      { ..request, command: "apply", },
      { ..request, verify_checks: Some([]), },
      { ..request, verify_checks: Some([{ name: "", sql: "SELECT 1;", }]), },
      {
        ..request,
        verify_checks: Some([
          { name: "same", sql: "SELECT 1;", },
          { name: "same", sql: "SELECT 1;", },
        ]),
      },
    ] {
    let rejected = VerificationDriver::{ calls: [], invalid_result: false, }
    try @moonmolt.prepare(rejected, invalid) catch {
      @moonmolt.Input(_) => ()
      _ => fail("expected invalid current verification request")
    } noraise {
      _ => fail("invalid current checks must fail before host work")
    }
    @test.assert_eq(rejected.calls.length(), 0)
  }
}

///|
priv struct FingerprintDriver {
  calls : Array[String]
  fingerprint : String
}

///|
impl @moonmolt.Driver for FingerprintDriver with fn call(self, op, _args) {
  self.calls.push(op)
  match op {
    "load" | "history" => []
    "application_id" => 0
    "fingerprint" => ToJson::to_json(self.fingerprint)
    _ => Json::null()
  }
}

///|
test "reviewed schema conditions are enforced by the core after locking and before verification" {
  let fingerprint = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  let request : @moonmolt.Request = {
    command: "apply",
    db: "legacy.db",
    dir: "",
    rebuild: false,
    create: false,
    to: None,
    expected_application_id: None,
    expected_version: None,
    expected_fingerprint: Some(fingerprint),
    verify_checks: None,
  }
  let driver = FingerprintDriver::{ calls: [], fingerprint, }
  let prepared = @moonmolt.prepare(driver, request)
  @test.assert_eq(prepared.fingerprint, fingerprint)
  @test.assert_eq(prepared.backup_required, false)
  @test.assert_eq(driver.calls, [
    "load", "open", "begin", "application_id", "history", "fingerprint",
  ])
  for command in ["apply", "verify"] {
    let rejected = FingerprintDriver::{ calls: [], fingerprint, }
    try
      @moonmolt.prepare(rejected, {
        ..request,
        command,
        expected_fingerprint: Some(
          "0000000000000000000000000000000000000000000000000000000000000000",
        ),
      })
    catch {
      @moonmolt.Policy(_) => ()
      _ => fail("expected a reviewed schema policy failure")
    } noraise {
      _ => fail("mismatched review must fail even for a no-op")
    }
    @test.assert_eq(
      rejected.calls[2],
      if command == "apply" {
        "begin"
      } else {
        "begin_read"
      },
    )
    @test.assert_eq(rejected.calls.contains("verify"), false)
  }
  for
    invalid in [
      "short", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ] {
    let rejected = FingerprintDriver::{ calls: [], fingerprint, }
    try
      @moonmolt.prepare(rejected, {
        ..request,
        expected_fingerprint: Some(invalid),
      })
    catch {
      @moonmolt.Input(_) => ()
      _ => fail("expected invalid digest input")
    } noraise {
      _ => fail("invalid digest must fail before host work")
    }
    @test.assert_eq(rejected.calls.length(), 0)
  }
}

///|
test "the reusable status helper exposes the current schema fingerprint" {
  let fingerprint = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  let driver = FingerprintDriver::{ calls: [], fingerprint, }
  let result = @moonmolt.status(driver, [], "source", None)
  @test.assert_eq(result, {
    "ok": true,
    "applied": [],
    "pending": [],
    "fingerprint": ToJson::to_json(fingerprint),
  })
}
