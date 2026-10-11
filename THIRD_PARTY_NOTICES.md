# Third-party notices

The generated JavaScript engine includes code compiled from the following MoonBit packages. MoonMolt's migration execution, Node adapter, CLI and documentation are developed in this repository.

- **kath61105/moon_schema_plan 0.4.0** — schema diff, risk classification and SQL rendering. Source: https://github.com/kath61105/moon-schema-plan . Licensed under Apache-2.0. MoonMolt adapts the rendered transaction wrappers without modifying the upstream package.
- **moonbitlang/core**, bundled with the installed MoonBit toolchain — standard types, collections and JSON handling. Source: https://github.com/moonbitlang/core . Copyright International Digital Economy Academy; source files carry copyright notices with their respective years, including Copyright 2026 International Digital Economy Academy. Licensed under Apache-2.0.

The Apache-2.0 license text is included in `LICENSE`. The dependency graph also resolves `moonbitlang/x@0.5.5` through the planner's manifest; it is not imported by MoonMolt's execution code.
