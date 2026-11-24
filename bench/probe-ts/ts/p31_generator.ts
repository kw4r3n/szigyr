function* range(n: number): Generator<number> {
  for (let i = 0; i < n; i++) yield i;
}
function* fib(): Generator<number, void, undefined> {
  let a = 0, b = 1;
  while (true) { yield a; [a, b] = [b, a + b]; }
}
function main(): void {
  console.log([...range(4)].join(","));
  let c = 0;
  for (const f of fib()) { if (c++ >= 8) break; console.log(f); }
}
main();
