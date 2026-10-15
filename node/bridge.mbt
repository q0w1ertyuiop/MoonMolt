///|
extern "js" fn host_call(op : String, args : String) -> String =
  #|(op, args) => globalThis.__moonmolt_dispatch(op, args)

///|
priv struct NodeDriver {}

///|
impl @core.Driver for NodeDriver with fn call(_self, op, args) {
  let response = @json.parse(host_call(op, args.stringify())) catch {
    _ => raise @core.Database("invalid host response")
  }
  match response {
    { "ok": true, "value": value, .. } => value
    { "kind": String(kind), "message": String(message), .. } =>
      match kind {
        "input" => raise @core.Input(message)
        "policy" => raise @core.Policy(message)
        "lock_timeout" => raise @core.LockTimeout(message)
        "commit_outcome_unknown" => raise @core.CommitOutcomeUnknown(message)
        "cancelled" => raise @core.Cancelled(message)
        _ => raise @core.Database(message)
      }
    _ => raise @core.Database("invalid host response envelope")
  }
}

///|
pub fn prepare_json(input : String) -> String {
  let result : Json = try {
    let request : @core.Request = @json.from_json(@json.parse(input)) catch {
      e => raise @core.Input(e.to_string())
    }
    let prepared = @core.prepare(NodeDriver::{ }, request)
    { "ok": true, "prepared": ToJson::to_json(prepared) }
  } catch {
    error => @core.error_json(error)
  }
  result.stringify()
}

///|
pub fn complete_json(input : String) -> String {
  let result : Json = try {
    let prepared : @core.Prepared = @json.from_json(@json.parse(input)) catch {
      _ => raise @core.Input("invalid prepared operation")
    }
    @core.complete(NodeDriver::{ }, prepared)
  } catch {
    error => @core.error_json(error)
  }
  result.stringify()
}

///|
pub fn plan_json(input : String) -> String {
  let result : Json = try {
    let value = @json.parse(input) catch {
      _ => raise @core.Input("invalid plan request")
    }
    match value {
      {
        "before": before,
        "after": after,
        "hints": hints,
        "allow_destructive": True,
        ..
      } => @core.plan(before, after, Some(hints), true)
      { "before": before, "after": after, "hints": hints, .. } =>
        @core.plan(before, after, Some(hints), false)
      _ => raise @core.Input("invalid plan request fields")
    }
  } catch {
    error => @core.error_json(error)
  }
  result.stringify()
}
