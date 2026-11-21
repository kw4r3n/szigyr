export interface ExplainEntry {
  readonly code: string;
  readonly phase: "P1" | "P2" | "P3" | "P4" | "runtime";
  readonly title: string;
  readonly description: string;
  readonly remediation: string;
}

const e = (
  code: string,
  phase: ExplainEntry["phase"],
  title: string,
  description: string,
  remediation: string,
): [string, ExplainEntry] => [code, { code, phase, title, description, remediation }];

const ENTRIES: Record<string, ExplainEntry> = Object.fromEntries([
  // P1 Syntax & Subset (E1000-E1009)
  e("E1000", "P1", "Disallowed syntax or reserved word", "Uses TypeScript/JavaScript syntax, a reserved identifier, a forbidden directive (e.g. '\"use strict\"'), or a BigInt literal (e.g. '1n') outside the Szigyr subset.", "Use allowed Szigyr syntax (e.g. switch, explicit loops, Record/Struct/Class, typed declarations), use '\"use owned\"' instead of '\"use strict\"' (or omit for managed), and omit 'n' on i64/u64 contextual numeric literals."),
  e("E1001", "P1", "'var' declaration not allowed", "'var' has function hoisting semantics that are outside the Szigyr subset.", "Replace 'var' with 'const' (immutable binding) or 'let' (mutable binding)."),
  e("E1002", "P1", "Loose equality '==' or '!='", "Implicit-coercion equality operators are disallowed.", "Use strict equality '===' or '!=='."),
  e("E1003", "P1", "Default export or star re-export not allowed", "Default exports ('export default', 'export { x as default }') and wildcard re-exports ('export *') are disallowed.", "Use named exports ('export function', 'export { ... }') and explicit named imports ('import { a, b } from \"...\"')."),
  e("E1004", "P1", "'any' type is not allowed", "Szigyr forbids untyped 'any' to guarantee soundness across JS and C.", "Replace 'any' with a concrete type, a generic with capability bounds, or 'unknown' with 'cast<T>' at boundaries."),
  e("E1005", "P1", "Type assertion ('as') is not allowed", "Unchecked TypeScript 'as' casts bypass runtime and native type safety.", "Use numeric conversion builtins (i32(x), i64(x), usize(x), f64(x)), tagged-union narrowing, or 'cast<T>(x)' for dynamic values."),
  e("E1006", "P1", "Non-null assertion ('!') is not allowed", "Postfix '!' silently assumes a nullable value is non-null.", "Narrow with 'if (x !== null)', handle null explicitly, or use 'x ?? fallback'."),
  e("E1007", "P1", "'throw' and 'try/catch' are not allowed", "Exceptions are replaced by typed Result<T, E> values and explicit traps.", "Return 'Result<T, E>' via 'ok(v)' / 'err(e)' or call 'panic(msg)' for unrecoverable bugs."),
  e("E1008", "P1", "Optional or default parameters/fields", "Optional parameters, default parameter values, and optional properties are disallowed.", "Pass explicit parameters using 'T | null' for optional values."),
  e("E1009", "P1", "Misplaced '\"use unsafe\"' modifier", "Valid layer directives are '\"use owned\"' (strict layer) and '\"use rt\"' (rt layer); '\"use unsafe\"' is a modifier allowed only once at the top of a '\"use owned\"' or '\"use rt\"' function (never at file top, in managed functions, or in arrows/methods).", "Place '\"use unsafe\"' alongside '\"use owned\"' or '\"use rt\"' (or inside a file with a file-top '\"use owned\"'/'\"use rt\"' directive) at the top of a named top-level function."),

  // P2/P4 Types, Authorities & C Headers (E2000-E2013)
  e("E2000", "P2", "Unresolved name or disallowed global", "Identifier is not in scope, references a reserved global name, or accesses an unknown type.", "Declare or import the symbol cleanly or pass the required authority parameter explicitly."),
  e("E2001", "P2", "Unknown member or invalid member access", "Property or method does not exist on the receiver type or cannot be accessed in this context.", "Check the type's declared fields or query the built-in member allowlist (via 'szigyr query' or MCP resource 'szigyr://builtins')."),
  e("E2002", "P2", "Type or capability mismatch", "Expression type, generic capability constraint (Copy, Native, Owned, Send, Key, Codec), or usage position does not match requirements (e.g. cast<T>, js.decode<T>, js.callback<T>, Arena.alloc<T>, and JSON.stringify<T> require concrete types without type parameters; JSON.stringify also forbids i64/u64).", "Align the expression type, add explicit capability bounds (e.g. 'T extends Copy & Native'), use concrete types where required, or adjust target type annotations."),
  e("E2003", "P2", "Mixed numeric types in operator", "Arithmetic, comparison, bitwise, or equality operators require both operands to share the same exact numeric type (i8..f64).", "Explicitly convert one side (e.g. 'f64(x)', 'i32(y)') or annotate the 'let' variable with the matching numeric type."),
  e("E2004", "P2", "Condition must be boolean", "Conditionals (if, while, do-while, for, ?:, &&, ||, !) only accept 'boolean', not truthy/falsy values.", "Compare explicitly (e.g. 'x !== 0', 's.length > 0', 'v !== null')."),
  e("E2005", "P2", "Non-exhaustive switch", "A 'switch' over a string-literal union, tagged union ('kind'), boolean, or other value omits cases without a 'default' branch.", "Add the missing 'case' branches reported in diagnostic data or add a 'default' clause."),
  e("E2006", "P2", "Missing type annotation or contextual type", "Type inference requires an explicit type annotation or expected contextual type (e.g. empty literal, ok/err without context, untyped parameter).", "Add an explicit type annotation on the variable, parameter, or call site."),
  e("E2007", "P2", "Integer '/' operator is not allowed", "Integer '/' is ambiguous between truncating and floating-point division.", "Use 'divTrunc(a, b)' for integer truncating division, or convert operands to f32/f64."),
  e("E2008", "P2", "Numeric literal out of range", "Numeric literal does not fit cleanly into the target integer/float type or loses integer precision.", "Use an explicit literal within range or widen the target type."),
  e("E2009", "P4", "C header verification failure", "C FFI declaration ('declare module \"c:...\"') does not match the installed C header when probed by the C compiler.", "Install the system headers/pkg-config package and match the declared C struct layout, constant value, or function signature to the header (inspect 'ccStderr' in data)."),
  e("E2010", "P2", "Invalid Port usage", "Channel Port<S, R> must satisfy 'Send' bounds and ownership/protocol rules.", "Ensure channel message types satisfy 'Send' and are moved properly."),
  e("E2011", "P2", "Invalid spawn.isolate entry", "An isolate entry function must be a module-level non-generic managed function taking '(port: Port<R, S>): void | Promise<void>' or '(port: Port<R, S>, alloc: Alloc): void | Promise<void>'.", "Pass a named top-level managed function (no '\"use owned\"' or '\"use rt\"') taking 'Port<R, S>' (plus optional 'Alloc') and returning void or Promise<void>."),
  e("E2012", "P2", "Invalid string / lone surrogate", "A string-literal type contains an unpaired UTF-16 surrogate that has no valid UTF-8 encoding.", "Ensure string-literal types contain only valid UTF-16/UTF-8 scalar values."),
  e("E2013", "P2", "Invalid audio.open call", "Audio state or render callback violates constraints (state must be Native & Send; callback must be safe '\"use rt\"' non-generic).", "Ensure audio state satisfies 'Native & Send' (e.g. Struct/Vec/Pool/Arena/Ring) and the render callback has signature `(st: Mut<S> | S, out: Mut<Slice<f32>>, frames: usize): void`."),

  // P3 Ownership & Borrowing (E3001-E3008)
  e("E3001", "P3", "Use of moved value", "An owned value was moved cleanly elsewhere and cannot be read again.", "Borrow with Ref<T> / Mut<T> if the caller still needs it, clone explicitly if Copy, or reorder uses."),
  e("E3002", "P3", "Move inside loop", "Moving a variable bound outside a loop would leave it uninitialized on the next iteration.", "Borrow the outer value inside the loop or create/rebind the owned value per iteration."),
  e("E3003", "P3", "Partial move", "Moved part of a struct/record and subsequently used the parent or conflicting field.", "Borrow fields instead of moving them, or move all consumed fields independently without reusing the parent."),
  e("E3004", "P3", "Borrow or Resource escapes or lifetime violation", "A borrowed Ref<T>/Mut<T>, Slice<T>, or 'using' Resource<T> binding cannot escape its allowed slot (cannot be stored, assigned, returned, captured by closures, or used in async parameter lists).", "Return or store an owned value instead of a borrow, use '.borrow()' / '.get()' / '.take()' directly on 'using' Resource<T> bindings, or complete borrowed work synchronously."),
  e("E3005", "P3", "Exclusive Mut<T> aliasing conflict", "Multiple overlapping mutable borrows or simultaneous mutable + shared borrows of the same root variable exist.", "Separate borrow scopes sequentially or pass disjoint roots."),
  e("E3006", "P3", "Cannot pass Ref<T> where Mut<T> is expected", "A shared immutable borrow (Ref<T>) cannot satisfy an exclusive mutable borrow (Mut<T>).", "Accept 'Mut<T>' in the enclosing function or work on an owned mutable binding."),
  e("E3007", "P3", "Owned value not allowed in managed data or closure", "Owned values cannot be stored in Array, ReadonlyArray, Map, Set, Promise, Result ('ok'/'err'), managed records, closures, or unconstrained managed generics.", "Use 'OwnedCell<T>', 'Struct<{...}>', 'Port<S, R>', or 'using r = Resource.own(...)' to manage or transfer Owned values."),
  e("E3008", "P3", "Invalid move or borrow place expression", "Borrow or move operator requires a valid variable/field/place expression.", "Bind intermediate expressions to a local variable first."),

  // P2 Layers, Determinism & FFI (E4001-E4010)
  e("E4001", "P2", "Layer call violation", "Call graph violates managed/strict/rt layer hierarchy (managed calls all; strict '\"use owned\"' calls strict/rt; rt '\"use rt\"' calls safe rt; rt+unsafe can only be called from rt+unsafe or passed to 'cfn').", "Move the helper into the compatible layer ('\"use owned\"' or '\"use rt\"') or move the call to a managed caller."),
  e("E4002", "P2", "Non-Native value in strict/rt layer", "Managed-only types (string, mutable records without Struct, GC Array/Map/Set, class/interface/closures) cannot be used in strict ('\"use owned\"') or rt ('\"use rt\"') code.", "Use Native types: i8..f64, boolean, null, string-literal unions, all-readonly Native & Copy records, Struct, Vec, Pool, Handle, Arena, ArenaBuf, RingTx/RingRx, or CHandle."),
  e("E4003", "P2", "Invalid strict/rt function reference", "First-class/indirect function passing in strict/rt/cfn/forAll only accepts allowed top-level non-generic function names or function parameters.", "Pass a concrete module-level function name matching the required layer and signature."),
  e("E4004", "P2", "Allocation not allowed in 'use rt'", "Real-time ('\"use rt\"') functions cannot allocate or grow buffers (e.g. Vec.push/create, Pool.create, Arena.create, Ring.create, Ptr.box, new).", "Pre-allocate Vec/Pool/Arena/Ring in managed/strict setup and borrow or use fixed-capacity slots in 'rt' (stack-scoped 'using' with 'Resource.own'/'ownWith' is zero-allocation and allowed in 'rt')."),
  e("E4005", "P2", "Recursion not allowed in 'use rt'", "Direct or mutual recursion (including through function parameters) is forbidden in real-time code to bound stack usage.", "Rewrite recursively bounded logic as an explicit bounded loop."),
  e("E4006", "P2", "Authority not allowed in 'use rt'", "Real-time ('\"use rt\"') functions cannot accept or hold authorities (System, Log, Clock, Random, Fs, etc.).", "Move authority operations to strict/managed code or pre-allocate/pass pure data into 'rt'."),
  e("E4007", "P2", "Invalid C FFI signature or type", "Type used in 'c:' module or 'cfn' cannot safely cross the C ABI boundary.", "Restrict FFI signatures to C-compatible primitives, CStruct, Ptr<T>, ConstPtr<T>, and void."),
  e("E4008", "P2", "Unsafe operation without '\"use unsafe\"'", "Calling C functions, manipulating raw Ptr<T>, or calling unsafe helpers requires '\"use unsafe\"'.", "Mark the enclosing strict/rt function with '\"use unsafe\"' or wrap in safe CHandle/Resource APIs."),
  e("E4009", "P2", "C-only feature requires C backend", "'\"use unsafe\"', raw 'Ptr', or 'c:' FFI cannot execute under --backend=js or --backend=wasm.", "Run or test this module with '--backend=c'."),
  e("E4010", "P2", "Polymorphic recursion is not allowed", "Generic function calls itself (directly or mutually) with different/constructed type arguments, preventing finite monomorphization.", "Keep recursive generic type arguments invariant or extract a non-generic helper."),

  // P1/P2 Ambient Globals & Module State (E5001-E5002)
  e("E5001", "P2", "Ambient nondeterministic global used", "Direct use of console/Date/performance/Math.random breaks capability explicitness and determinism.", "Accept an explicit authority parameter (log: Log, clock: Clock, random: Random) and apply the quick fix."),
  e("E5002", "P1", "Mutable or impure top-level module state", "Top-level 'let' declarations and side-effectful module initializers are disallowed.", "Pass mutable state explicitly or use immutable primitive/literal 'const' definitions."),

  // P1/P2 Contracts & Tests (E6001-E6005)
  e("E6001", "P1", "Misplaced contract call", "'requires', 'invariant', or 'ensures' appeared outside an allowed leading function/loop/forAll contract position.", "Place 'requires'/'ensures' at the top of a function body and 'invariant' at the top of a loop body."),
  e("E6002", "P2", "Contract references disallowed function, reference, or nondeterminism", "Contracts must be side-effect free and deterministic and cannot hold mutable borrows or nondeterministic calls.", "Restrict contract predicates to pure deterministic expressions and read-only parameters."),
  e("E6003", "P1", "Misplaced 'test(...)' declaration", "'test(...)' can only appear as a top-level expression statement in the entry module.", "Move 'test(...)' to module top level with a string literal name."),
  e("E6004", "P1", "Misplaced 'forAll(...)' call", "'forAll(...)' is only valid directly inside a 'test(...)' body.", "Call 'forAll(...)' inside a top-level 'test(\"name\", (t: Test) => { ... })'."),
  e("E6005", "P2", "Ungeneratable 'forAll' parameter type", "Parameter type of a 'forAll' property function has no automatic generator (requires Copy/Supported types, not opaque handles/functions).", "Pass simpler value/struct types into 'forAll' and construct complex wrappers inside the property body."),

  // P1 Modules (E7001-E7002)
  e("E7001", "P1", "Invalid import/export or missing module", "Import specifier must be relative '*.szigyr' or 'npm:<pkg>', target must exist, and imports/exports must match module exports.", "Use './name.szigyr', '../name.szigyr', or 'npm:<pkg>' and verify exported names exist."),
  e("E7002", "P1", "Invalid 'c:' ambient module declaration", "Ambient 'declare module \"c:<pkg>:<header>\"' syntax or placement is invalid.", "Use valid 'declare module \"c:<pkg>:<header>\"' declarations with allowed C types and Ffi functions."),

  // Warnings (W8001)
  e("W8001", "P3", "Strict/rt call inside a managed loop", "Calling a strict ('\"use owned\"') or rt ('\"use rt\"') function inside a managed loop crosses the JS/native boundary on every iteration.", "Move the loop into the strict/rt function and pass a Vec/Slice buffer instead of calling per element."),

  // Runtime Traps (T001-T015)
  e("T001", "runtime", "Signed/unsigned integer overflow", "Checked integer arithmetic (+, -, *, divTrunc(MIN, -1), conversion/negation) overflowed the target type range.", "Use wider integer types (e.g. i32/u32/i64/u64/usize) or f64, validate inputs with 'requires', or use explicit wrapAdd/wrapSub/wrapMul where wraparound is intended."),
  e("T002", "runtime", "Index out of bounds", "Array, Vec, Slice, or string index/slice/charCodeAt access fell outside valid bounds.", "Check bounds before indexing or iterate safely within '[0, length)'."),
  e("T003", "runtime", "Invalid numeric or usize cast", "Checked cast from NaN, out-of-range float, or negative number into integer / usize failed (including C FFI usize boundary bounds).", "Guard conversions with range/finite checks or handle bounds before converting."),
  e("T004", "runtime", "Contract 'requires' failed", "A function precondition (`requires(cond)`) evaluated to false at runtime.", "Fix caller arguments to satisfy the precondition or strengthen input validation."),
  e("T005", "runtime", "Contract 'ensures' failed", "A function postcondition (`ensures(...)`) evaluated to false upon return.", "Fix the function implementation or update the postcondition specification."),
  e("T006", "runtime", "Explicit panic, OOM, stack overflow, or JS error", "Triggered by `panic(msg)`, out-of-memory, call stack overflow, or caught JS host error/await failure.", "Inspect message/stack position, ensure bounded recursion/allocation, or handle expected failures with Result."),
  e("T007", "runtime", "Division or remainder by zero", "Integer division or remainder ('divTrunc', 'rem') received divisor 0. (Note: 'divTrunc(MIN, -1)' traps T001, and 'rem(MIN, -1) === 0'.)", "Validate divisor !== 0 with 'requires' or explicit checks."),
  e("T008", "runtime", "OwnedCell / single-owner runtime violation", "Runtime single-owner check failed (calling 'take()' on an empty OwnedCell or 'put()' on a full OwnedCell).", "Check 'isEmpty()' before calling 'take()' or 'put()' on an OwnedCell."),
  e("T009", "runtime", "Invalid bitwise shift amount", "Bitwise shift count was negative or >= bit width ([0, 31] for i32/u32; [0, 63] for i64/u64).", "Validate or mask shift amounts within '[0, 31]' (32-bit) or '[0, 63]' (64-bit) before shifting."),
  e("T010", "runtime", "Loop 'invariant' failed", "A loop `invariant(cond)` evaluated to false on entry or after an iteration.", "Fix loop state update logic or correct the invariant condition."),
  e("T011", "runtime", "Invalid Pool Handle<T>", "Called 'get', 'set', or 'remove' on a Pool Handle<T> that was removed, came from another Pool, or is out of range.", "Check 'pool.has(h)' before accessing or do not reuse handles after 'pool.remove(h)'."),
  e("T012", "runtime", "Invalid ArenaBuf<T> in Arena.view", "Called 'Arena.view' with an ArenaBuf<T> created before 'arena.reset()' or from a different Arena (note 'Arena.alloc' returns null when out of space rather than trapping).", "Do not retain ArenaBuf<T> handles across 'arena.reset()' or pass them to another Arena."),
  e("T013", "runtime", "Overlapping slice/view arguments", "Two 'slice' or 'view' arguments derived from the same root overlapped in a single call where at least one was 'Mut'.", "Pass non-overlapping slice ranges or separate calls sequentially."),
  e("T014", "runtime", "Invalid Ring buffer capacity", "'Ring.create' was called with a capacity that is not a power of two in '1..2^31'.", "Pass a power-of-two capacity in '1..2^31' (e.g. 16, 64, 1024) to 'Ring.create'."),
  e("T015", "runtime", "Null pointer dereference", "Called 'read', 'write', 'offset', 'slice', 'borrow', or 'unbox' on a null Ptr<T> / ConstPtr<T>.", "Check 'ptr.isNull()' before dereferencing or offsetting raw pointers."),
]);

export function explainCode(code: string): ExplainEntry | undefined {
  return ENTRIES[code.trim().toUpperCase()];
}
