---
name: typescript-best-practices
description: TypeScript and TSX best practices. Use when reading, writing, reviewing, debugging, or refactoring .ts and .tsx files.
metadata:
  source: https://github.com/cursor/plugins/tree/main/pstack/skills/typescript-best-practices
---

# TypeScript Best Practices

Apply these rules alongside the repository's existing conventions. Prefer the
repository's established runtime schema library, generated types, logger,
testing tools, and formatting rules.

| Rule | Summary |
|------|---------|
| Discriminated unions | Model variants with a literal discriminant so impossible states cannot be represented. Avoid optional-field bags. |
| Branded types | Brand primitives when otherwise-compatible values must not be mixed. Validate once at the boundary. |
| Constructive modeling | Build types from legal parts, such as `[T, ...T[]]` for non-empty arrays or `[T, T][]` for pairs. |
| Simplest total type | Keep `T[]` while operations remain total. Strengthen only when the loose type forces assertions or impossible-state errors. |
| `unknown` over `any` | Treat external data as `unknown` and narrow it before use. |
| Schemas before guards | Prefer the repository's runtime schema library over duplicate interfaces and hand-written property guards. |
| Avoid `as` casts | Cast only after validation when TypeScript cannot express the verified fact. |
| Narrowing hierarchy | Prefer discriminants, then `in`, `typeof`/`instanceof`, verified type guards, and casts only as a last resort. |
| Type guards | Verify the full claim and name guards `isX` or `hasX`. |
| Exhaustiveness | Assign unhandled variants to `never` so additions fail compilation. |
| `satisfies` over `as` | Validate object shapes without widening literals. |
| Boundary validation | Parse external data once at the boundary into a named domain type, then trust it internally. |
| Schema-derived types | Prefer `Pick`, `Omit`, `Parameters`, `ReturnType`, `Awaited`, and `typeof` over duplicate declarations. |
| Object arguments | Prefer object parameters when positional arguments can be confused; avoid extra allocation on proven hot paths. |
| Real tests | Run real code where practical and mock only unavailable boundaries. |
| Structured telemetry | Use the repository logger with diagnostic context rather than shipped `console.log` calls. |

See `references/patterns.md` for examples.
