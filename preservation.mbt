///|
fn capture_preserved(
  driver : &Driver,
  id : String,
  migration : Migration,
) -> Array[Json] raise MigrationError {
  match migration.preserve {
    None => []
    Some(queries) =>
      queries.map(query => {
        driver.call("capture_value", {
          "id": ToJson::to_json(id),
          "sql": ToJson::to_json(query.sql),
          "name": ToJson::to_json(query.name),
          "filename": ToJson::to_json(migration.filename),
          "phase": "before",
        })
      })
  }
}

///|
fn verify_preserved(
  driver : &Driver,
  id : String,
  migration : Migration,
  baseline : Array[Json],
) -> Array[Json] raise MigrationError {
  let verified : Array[Json] = []
  if migration.preserve is Some(queries) {
    guard queries.length() == baseline.length() else {
      raise Database("preservation baseline count changed")
    }
    for i, query in queries {
      let actual = driver.call("capture_value", {
        "id": ToJson::to_json(id),
        "sql": ToJson::to_json(query.sql),
        "name": ToJson::to_json(query.name),
        "filename": ToJson::to_json(migration.filename),
        "phase": "after",
      })
      guard actual == baseline[i] else {
        raise Policy(
          "\{migration.filename}: preservation failed for \{query.name}; query result changed",
        )
      }
      verified.push({
        "version": ToJson::to_json(migration.version),
        "filename": ToJson::to_json(migration.filename),
        "name": ToJson::to_json(query.name),
        "ok": true,
      })
    }
  }
  verified
}
