///|
pub(all) suberror MigrationError {
  Input(String)
  HistoryMismatch(String)
  Policy(String)
  Database(String)
  LockTimeout(String)
  CommitOutcomeUnknown(String)
} derive(Debug)

///|
pub(all) struct Migration {
  version : Int
  name : String
  filename : String
  checksum : String
  sql : String
} derive(Debug, Eq, ToJson, @json.FromJson)

///|
pub(all) struct HistoryEntry {
  version : Int
  name : String
  checksum : String
  applied_at : String
  duration_ms : Int64
  schema_before : String
  schema_after : String
  tool_version : String
} derive(Debug, Eq, ToJson, @json.FromJson)

///|
pub(all) struct MigrationSource {
  filename : String
  checksum : String
  sql : String
} derive(Debug, ToJson, @json.FromJson)

///|
pub(all) struct Request {
  command : String
  db : String
  dir : String
  rebuild : Bool
  create : Bool
  to : Int?
} derive(Debug, ToJson, @json.FromJson)

///|
/// Synchronous host operations; backup is performed between prepare and complete.
pub(open) trait Driver {
  fn call(Self, String, Json) -> Json raise MigrationError
}

///|
pub(all) struct Prepared {
  request : Request
  pending : Array[Migration]
  backup_required : Bool
  report : Json
  fingerprint : String
  history : Array[HistoryEntry]
} derive(Debug, ToJson, @json.FromJson)

///|
priv struct SequenceState {
  name : String
  seq : Int64?
} derive(@json.FromJson)

///|
pub(all) struct SchemaSnapshot {
  objects : Array[Json]
  tables : Array[Json]
  fingerprint : String
  sqlite_version : String
} derive(Debug, ToJson, @json.FromJson)

///|
pub fn error_json(error : MigrationError) -> Json {
  let (kind, code, message) = match error {
    Input(s) => ("input", 1, s)
    HistoryMismatch(s) => ("history_mismatch", 2, s)
    Policy(s) => ("policy", 2, s)
    Database(s) => ("database", 1, s)
    LockTimeout(s) => ("lock_timeout", 3, s)
    CommitOutcomeUnknown(s) => ("commit_outcome_unknown", 1, s)
  }
  {
    "ok": false,
    "kind": kind.to_json(),
    "exit_code": code.to_json(),
    "message": message.to_json(),
  }
}
