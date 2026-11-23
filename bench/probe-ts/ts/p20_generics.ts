interface Person { name: string; age: number }
function pick<T, K extends keyof T>(o: T, k: K): T[K] { return o[k]; }
function update(p: Person, patch: Partial<Person>): Person { return { ...p, ...patch }; }
function main(): void {
  const p: Person = { name: "A", age: 1 };
  console.log(pick(p, "name"), pick(p, "age"));
  console.log(update(p, { age: 2 }).age);
  const r: Record<string, number> = { a: 1, b: 2 };
  console.log(r["a"], Object.keys(r).length);
}
main();
