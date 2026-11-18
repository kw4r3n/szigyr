// expect-output: b=20
// expect-output: c=3
// expect-output: a=10
// expect-output: size=3 total=33
// expect-output: missing
// expect-output: b:20
// expect-output: c:3
// expect-output: a:10
// expect-output: 0 false
// stage: 1
// open-question: Q027
// open-question: Q029
// open-question: Q059
export function main(sys: System): void {
  const m = new Map<string, i32>();
  m.set("b", 2);
  m.set("a", 1);
  m.set("c", 3);
  m.set("b", 20);
  m.delete("a");
  m.set("a", 10);
  const miss: i32 = -1;
  for (const k of m.keys()) {
    sys.log.info(`${k}=${m.get(k) ?? miss}`);
  }
  let total: i32 = 0;
  for (const v of m.values()) {
    total += v;
  }
  sys.log.info(`size=${m.size} total=${total}`);
  const z: i32 | null = m.get("zz");
  sys.log.info(z === null ? "missing" : "present");
  m.forEach((v: i32, k: string): void => {
    sys.log.info(`${k}:${v}`);
  });
  m.clear();
  sys.log.info(`${m.size} ${m.has("a")}`);
}
