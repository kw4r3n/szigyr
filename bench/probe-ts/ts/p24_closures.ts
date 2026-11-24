function counter(): () => number {
  let c = 0;
  return () => { c += 1; return c; };
}
function compose<A, B, C>(f: (a: A) => B, g: (b: B) => C): (a: A) => C {
  return (a) => g(f(a));
}
function main(): void {
  const c = counter();
  c(); c();
  console.log(c());
  const h = compose((x: number) => x + 1, (y: number) => `v${y}`);
  console.log(h(4));
  const adders = [1, 2, 3].map((n) => (x: number) => x + n);
  console.log(adders.map((f) => f(10)).join(","));
}
main();
