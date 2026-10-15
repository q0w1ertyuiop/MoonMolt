///|
fn source(
  filename : String,
  checksum? : String = "sha",
  sql? : String = "SELECT 1;",
) -> @moonmolt.MigrationSource {
  { filename, checksum, sql, checks: None, }
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
test "cancellation has a distinct transport category and exit code" {
  let report = @moonmolt.error_json(@moonmolt.Cancelled("requested"))
  @test.assert_eq(report, {
    "ok": false,
    "kind": "cancelled",
    "exit_code": 4,
    "message": "requested",
  })
}
