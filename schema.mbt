///|
fn checked_object(
  value : Json,
  allowed : Array[String],
  path : String,
) -> Map[String, Json] raise MigrationError {
  match value {
    Object(fields) => {
      for key, _ in fields {
        guard allowed.contains(key) else {
          raise Policy(
            "unsupported schema field \{path}.\{key}; use reviewed SQL instead",
          )
        }
      }
      fields
    }
    _ => raise Input("expected object at \{path}")
  }
}

///|
fn model_array(
  fields : Map[String, Json],
  key : String,
) -> Array[Json] raise MigrationError {
  match fields.get(key) {
    Some(Array(items)) => items
    None => []
    _ => raise Input("expected array for \{key}")
  }
}

///|
fn validate_model_shape(value : Json) -> Unit raise MigrationError {
  let root = checked_object(value, ["version", "tables", "views"], "schema")
  for table in model_array(root, "tables") {
    let fields = checked_object(
      table,
      ["name", "columns", "indexes", "foreign_keys", "checks", "triggers"],
      "table",
    )
    for column in model_array(fields, "columns") {
      ignore(
        checked_object(
          column,
          [
            "name", "data_type", "nullable", "primary_key", "unique", "default_value",
          ],
          "column",
        ),
      )
    }
    for index in model_array(fields, "indexes") {
      ignore(checked_object(index, ["name", "columns", "unique"], "index"))
    }
    for foreign_key in model_array(fields, "foreign_keys") {
      ignore(
        checked_object(
          foreign_key,
          [
            "name", "columns", "referenced_table", "referenced_columns", "on_delete",
            "on_update",
          ],
          "foreign_key",
        ),
      )
    }
  }
}

///|
fn ensure_supported(schema : @schema.Schema) -> Unit raise MigrationError {
  guard schema.views.is_empty() else {
    raise Policy("automatic plans do not support views; use reviewed SQL")
  }
  for table in schema.tables {
    guard table.columns.filter(c => c.primary_key).length() <= 1 else {
      raise Policy("automatic plans do not support composite primary keys")
    }
    for column in table.columns {
      match column.data_type.to_upper() {
        "INTEGER" | "TEXT" | "REAL" | "BLOB" | "NUMERIC" => ()
        _ =>
          raise Policy(
            "automatic plans require a plain SQLite affinity type in \{table.name}.\{column.name}",
          )
      }
    }
    guard table.checks.is_empty() && table.triggers.is_empty() else {
      raise Policy(
        "automatic plans do not support CHECK constraints or triggers in \{table.name}",
      )
    }
    guard !table.name.to_lower().has_prefix("__moonmigrate_") &&
      !table.name.to_lower().has_prefix("sqlite_") else {
      raise Policy("reserved table name \{table.name}")
    }
  }
}

///|
/// Only exact control statements emitted by the pinned upstream renderer are removed.
pub fn unwrap_rendered_sql(
  statements : Array[String],
) -> String raise MigrationError {
  let body : Array[String] = []
  let mut phase = 0
  for statement in statements {
    match statement {
      "PRAGMA foreign_keys=OFF;" => {
        guard phase == 0 else {
          raise Policy("unexpected renderer transaction wrapper")
        }
        phase = 1
      }
      "BEGIN IMMEDIATE;" => {
        guard phase == 1 else { raise Policy("unexpected renderer BEGIN") }
        phase = 2
      }
      "COMMIT;" => {
        guard phase == 2 else { raise Policy("unexpected renderer COMMIT") }
        phase = 3
      }
      "PRAGMA foreign_keys=ON;" => {
        guard phase == 3 else {
          raise Policy("unexpected renderer foreign-key restore")
        }
        phase = 0
      }
      _ => {
        guard phase == 0 || phase == 2 else {
          raise Policy("unknown renderer wrapper form")
        }
        guard !statement.has_prefix("PRAGMA ") &&
          !statement.has_prefix("BEGIN ") &&
          !statement.has_prefix("COMMIT") else {
          raise Policy("unknown renderer control statement")
        }
        body.push(statement)
      }
    }
  }
  guard phase == 0 else {
    raise Policy("incomplete renderer transaction wrapper")
  }
  body.join("\n") + "\n"
}

///|
pub fn plan(
  before : Json,
  after : Json,
  hints : Json?,
  allow_destructive : Bool,
) -> Json raise MigrationError {
  validate_model_shape(before)
  validate_model_shape(after)
  let optional_nulls = @json.Replacer((key, value) => {
    match value {
      Null if key == "default_value" || key == "on_delete" || key == "on_update" =>
        None
      _ => Some(value)
    }
  })
  let previous = @schema.schema_from_json(before.transform(optional_nulls)) catch {
    e => raise Input(e.to_string())
  }
  let next = @schema.schema_from_json(after.transform(optional_nulls)) catch {
    e => raise Input(e.to_string())
  }
  ensure_supported(previous)
  ensure_supported(next)
  let renames : @schema.RenameHints = match hints {
    None => @schema.RenameHints::empty()
    Some(value) =>
      @json.from_json(value) catch {
        e => raise Input(e.to_string())
      }
  }
  let migration_plan = match
    @schema.build_plan(previous, next, @schema.SQLite, hints=renames) {
    Ok(value) => value
    Err(issues) => raise Input(ToJson::to_json(issues).stringify())
  }
  let rendered = match @schema.render_plan(migration_plan, allow_destructive~) {
    Ok(value) => value
    Err(issues) => raise Policy(ToJson::to_json(issues).stringify())
  }
  let sql = unwrap_rendered_sql(rendered.sql)
  let rebuild = migration_plan.steps.any(step => {
    match step.change {
      RebuildTable(_, _, _) => true
      _ => false
    }
  })
  {
    "ok": true,
    "sql": ToJson::to_json(sql),
    "requires_rebuild": ToJson::to_json(rebuild),
    "plan": @schema.plan_to_json(migration_plan),
  }
}
