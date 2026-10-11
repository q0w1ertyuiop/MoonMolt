///|
/// Parse the six-digit migration version without relying on locale or filenames supplied by the host.
pub fn load_migrations(
  sources : Array[MigrationSource],
) -> Array[Migration] raise MigrationError {
  let migrations : Array[Migration] = []
  for source in sources {
    let file = source.filename
    guard file.length() > 11 && file.has_suffix(".sql") && file[6] == '_' else {
      raise Input("expected 000001_name.sql, got \{file}")
    }
    let mut version = 0
    for i in 0..<6 {
      let ch = file[i].to_int()
      guard ch >= 48 && ch <= 57 else {
        raise Input("invalid version in \{file}")
      }
      version = version * 10 + ch - 48
    }
    guard version > 0 else { raise Input("migration version must be positive") }
    let name = file[7:file.length() - 4].to_owned()
    for ch in name {
      guard (ch >= 'a' && ch <= 'z') ||
        (ch >= 'A' && ch <= 'Z') ||
        (ch >= '0' && ch <= '9') ||
        ch == '_' ||
        ch == '-' else {
        raise Input(
          "migration name must use ASCII letters, digits, underscore or hyphen: \{file}",
        )
      }
    }
    migrations.push({
      version,
      name,
      filename: file,
      checksum: source.checksum,
      sql: source.sql,
    })
  }
  migrations.sort_by((a, b) => a.version - b.version)
  for i in 1..<migrations.length() {
    guard migrations[i - 1].version != migrations[i].version else {
      raise Input("duplicate version \{migrations[i].version}")
    }
  }
  migrations
}

///|
/// Applied migrations must be an exact prefix, including names and raw-byte checksums.
pub fn validate_history(
  migrations : Array[Migration],
  history : Array[HistoryEntry],
) -> Unit raise MigrationError {
  guard history.length() <= migrations.length() else {
    raise HistoryMismatch("applied migration file is missing")
  }
  for i in 0..<history.length() {
    let applied = history[i]
    let candidate = migrations[i]
    guard applied.duration_ms >= 0 else {
      raise HistoryMismatch("negative duration in migration \{applied.version}")
    }
    if i > 0 {
      guard history[i - 1].schema_after == applied.schema_before else {
        raise HistoryMismatch(
          "broken schema fingerprint chain at migration \{applied.version}",
        )
      }
    }
    guard applied.version == candidate.version &&
      applied.name == candidate.name &&
      applied.checksum == candidate.checksum else {
      raise HistoryMismatch(
        "migration \{applied.version} no longer matches the local prefix",
      )
    }
  }
}

///|
pub fn pending_migrations(
  migrations : Array[Migration],
  history : Array[HistoryEntry],
  to : Int?,
) -> Array[Migration] raise MigrationError {
  validate_history(migrations, history)
  match to {
    Some(target) => {
      guard migrations.any(m => m.version == target) else {
        raise Input("target version \{target} does not exist")
      }
      if !history.is_empty() && target < history[history.length() - 1].version {
        raise Policy("downgrades are not supported")
      }
    }
    None => ()
  }
  migrations[history.length():]
  .to_owned()
  .filter(m => {
    match to {
      Some(target) => m.version <= target
      None => true
    }
  })
}
