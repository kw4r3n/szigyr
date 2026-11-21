// expect: ok
// stage: 1
// open-question: Q032
// open-question: Q035
type Config = { readonly name: string; readonly retries: u32; readonly tags: Array<string> };

export function load(text: string): Result<Config, CastError> {
  const p = JSON.parse(text);
  if (p.kind === "err") {
    return err(p.error);
  }
  return cast<Config>(p.value);
}

function countOf(text: string): u32 {
  const p = JSON.parse(text);
  if (p.kind === "err") {
    return 0;
  }
  return asCount(p.value);
}

function nameOf(text: string): string {
  const p = JSON.parse(text);
  if (p.kind === "err") {
    return "?";
  }
  return asName(p.value);
}

export function asCount(x: unknown): u32 {
  const r = cast<u32>(x);
  if (r.kind === "err") {
    return 0;
  }
  return r.value;
}

export function asName(x: unknown): string {
  const r = cast<string | null>(x);
  if (r.kind === "err") {
    return "?";
  }
  return r.value ?? "null";
}

export function dump(c: Config): string {
  return JSON.stringify(c);
}

test("cast", (t: Test) => {
  const r = load("{\"name\":\"a\",\"retries\":3,\"tags\":[\"x\"]}");
  if (r.kind === "ok") {
    t.eq(r.value.retries, 3);
    t.eq(r.value.tags.length, 1);
  } else {
    t.ok(false);
  }
  const bad = load("{\"name\":1}");
  t.ok(bad.kind === "err");
  t.eq(countOf("7"), 7);
  t.eq(countOf("-1"), 0);
  t.eq(nameOf("null"), "null");
  t.eq(nameOf("{"), "?");
  const c: Config = { name: "a", retries: 1, tags: [] };
  t.ok(dump(c).includes("\"retries\":1"));
});
