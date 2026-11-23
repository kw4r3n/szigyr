function main(): void {
  const m = new Map<string, number>();
  m.set("a", 1); m.set("b", 2);
  m.set("a", (m.get("a") ?? 0) + 10);
  console.log(m.get("a"), m.get("z"), m.has("b"), m.size);
  for (const [k, v] of m) console.log(k, v);
  const s = new Set<number>([1, 2, 2, 3]);
  s.add(3); s.add(4);
  console.log(s.size, s.has(2));
}
main();
