///|
pub extend MigrationError with Debug::{to_repr}

///|
pub extend Migration with Debug::{to_repr}

///|
pub extend Migration with Eq::{equal, not_equal}

///|
pub extend Migration with ToJson::{to_json}

///|
pub extend Migration with @json.FromJson::{from_json}

///|
pub extend HistoryEntry with Debug::{to_repr}

///|
pub extend HistoryEntry with Eq::{equal, not_equal}

///|
pub extend HistoryEntry with ToJson::{to_json}

///|
pub extend HistoryEntry with @json.FromJson::{from_json}

///|
pub extend MigrationSource with Debug::{to_repr}

///|
pub extend MigrationSource with ToJson::{to_json}

///|
pub extend MigrationSource with @json.FromJson::{from_json}

///|
pub extend Request with Debug::{to_repr}

///|
pub extend Request with ToJson::{to_json}

///|
pub extend Request with @json.FromJson::{from_json}

///|
pub extend Prepared with Debug::{to_repr}

///|
pub extend Prepared with ToJson::{to_json}

///|
pub extend Prepared with @json.FromJson::{from_json}

///|
pub extend SchemaSnapshot with Debug::{to_repr}

///|
pub extend SchemaSnapshot with ToJson::{to_json}

///|
pub extend SchemaSnapshot with @json.FromJson::{from_json}

///|
pub extend MigrationCheck with Debug::{to_repr}

///|
pub extend MigrationCheck with Eq::{equal, not_equal}

///|
pub extend MigrationCheck with ToJson::{to_json}

///|
pub extend MigrationCheck with @json.FromJson::{from_json}
