# TypeScript Patterns

Examples supporting the rules in `SKILL.md`.

## Branded Types

Brand primitives only when otherwise-compatible values must not be mixed.

```ts
type AgentId = string & { readonly __brand: "AgentId" };

function parseAgentId(input: string): AgentId {
	if (!isUUID(input)) throw new Error(`Invalid agent id: ${input}`);
	return input as AgentId;
}

function focusAgent(id: AgentId): void {
	// The boundary parser established the invariant.
}
```

## Discriminated Unions

```ts
// Avoid contradictory combinations of booleans and optional fields.
type DiffState =
	| { kind: "loading" }
	| { kind: "ready"; diff: GitDiff }
	| { kind: "error"; error: string };
```

Use one discriminant convention consistently within a domain.

## Constructive Modeling

```ts
type NonEmpty<T> = [T, ...T[]];
type Pairs<T> = [T, T][];
type TimeRange = { start: Date; durationMs: number };

function pickWinner(entries: NonEmpty<string>): string {
	return entries[Math.floor(Math.random() * entries.length)];
}

const isNonEmpty = <T>(items: T[]): items is NonEmpty<T> => items.length > 0;
```

Prefer representations where invalid values cannot be constructed.

## Simplest Total Type

Do not strengthen types reflexively.

```ts
const sum = (values: number[]): number =>
	values.reduce((total, value) => total + value, 0);

function newestSession(sessions: NonEmpty<Session>): Session {
	return sessions[0];
}
```

Use `T | undefined` when absence is a legitimate result. Use `NonEmpty<T>`
when callers must establish non-emptiness.

## Unknown Over Any

```ts
function handle(input: unknown): void {
	if (typeof input === "object" && input !== null && "foo" in input) {
		// The compiler now knows that `foo` exists.
	}
}
```

External sources include JSON, RPC payloads, IPC, files, environment variables,
database results, and message events.

## Schemas Before Guards

Use the schema system already present in the repository.

```ts
import { z } from "zod";

const UserSchema = z.object({
	id: z.string().uuid(),
	role: z.enum(["admin", "member"]),
});

type User = z.infer<typeof UserSchema>;

function parseUser(input: unknown): User {
	return UserSchema.parse(input);
}
```

Use `safeParse` when invalid input is an expected branch. Do not maintain a
schema, duplicate interface, and hand-written guard for the same shape.

## Avoid Unverified Casts

Before adding a cast, determine why inference failed:

- Add a discriminant when variants are ambiguous.
- Narrow an overly broad source type.
- Parse an untyped boundary.
- Use a branded type for a validated invariant.
- Use `satisfies` when validating an object literal.

Any unavoidable cast should be adjacent to the validation that earns it.

## Narrowing Hierarchy

Prefer, in order:

1. Discriminated union checks.
2. The `in` operator.
3. `typeof` or `instanceof`.
4. A verified user-defined type guard.
5. A cast after validation.

```ts
function area(shape: Shape): number {
	if ("radius" in shape) return Math.PI * shape.radius ** 2;
	return shape.width * shape.height;
}
```

## Exhaustiveness

```ts
function area(shape: Shape): number {
	switch (shape.kind) {
		case "circle":
			return Math.PI * shape.radius ** 2;
		case "rect":
			return shape.width * shape.height;
		default: {
			const exhaustive: never = shape;
			return exhaustive;
		}
	}
}
```

## Satisfies Over Casts

```ts
const config = {
	theme: "dark",
	columns: 3,
} satisfies Config;
```

This validates the value while retaining useful literal types.

## Boundary Validation

Validate once where data enters the system. Inside the boundary, use the named
domain type instead of passing `unknown` or `Record<string, unknown>` through
the call graph. Version persisted formats and handle expected parse failures.

## Schema-Derived Types

```ts
import type { ChecksMessage } from "<generated module>";

function renderChecks(
	summary: Pick<ChecksMessage, "totalCount" | "checks">,
): void {
	// The generated schema remains the source of truth.
}
```

Also consider `Omit`, `Parameters`, `ReturnType`, `Awaited`, and `typeof` before
introducing another interface.

## Object Arguments

```ts
openFile({
	uri,
	selection: {
		startLineNumber: 10,
		startColumn: 1,
		endLineNumber: 10,
		endColumn: 1,
	},
});
```

Object arguments make order and meaning explicit. Positional arguments remain
appropriate for small conventional APIs and allocation-sensitive hot paths.

## Tests And Telemetry

Exercise real parsing, serialization, storage, and framework primitives when
they can run locally. Mock network or platform boundaries that are genuinely
unavailable. Log structured context sufficient to identify the operation and
affected domain object; avoid shipped debugging output.
