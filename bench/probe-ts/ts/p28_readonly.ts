interface Pt { readonly x: number; readonly y: number }
function sumAll(xs: readonly number[]): number {
  let t = 0;
  for (const x of xs) t += x;
  return t;
}
function main(): void {
  const p: Pt = { x: 1, y: 2 };
  const xs: ReadonlyArray<number> = [1, 2, 3];
  console.log(p.x + p.y, sumAll(xs));
}
main();
