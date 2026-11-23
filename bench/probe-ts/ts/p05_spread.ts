interface P { a: number; b: string }
function main(): void {
  const xs = [1, 2, 3];
  const ys = [0, ...xs, 4];
  console.log(ys.join(","));
  const p: P = { a: 1, b: "x" };
  const q: P = { ...p, b: "y" };
  console.log(p.b, q.b, q.a);
  console.log(Math.max(...xs));
}
main();
