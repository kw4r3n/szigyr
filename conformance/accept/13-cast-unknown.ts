// expect: ok
// stage: 1
// open-question: Q032
type Config = { readonly name: string; readonly retries: u32; readonly tags: Array<string> };

export function load(text: string): Result<Config, CastError> {
  return cast<Config>(JSON.parse(text));
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
  t.eq(asCount(JSON.parse("7")), 7);
  t.eq(asCount(JSON.parse("-1")), 0);
  t.eq(asName(JSON.parse("null")), "null");
  const c: Config = { name: "a", retries: 1, tags: [] };
  t.ok(dump(c).includes("\"retries\":1"));
});
