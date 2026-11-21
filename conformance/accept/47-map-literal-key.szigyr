// expect: ok
// stage: 1
// open-question: Q081
type Level = "info" | "warn" | "error";
export function count(m: Map<Level, i32>, s: Set<"a">): usize {
  const t = new Map<"x" | "y", f64>();
  t.set("x", 1);
  return m.size + s.size + t.size;
}
