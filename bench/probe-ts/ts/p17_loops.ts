function main(): void {
  const xs = [10, 20, 30];
  for (const x of xs) console.log("of", x);
  const o = { a: 1, b: 2 };
  for (const k in o) console.log("in", k);
  let t = 0;
  for (let i = 0; i < xs.length; i++) t += xs[i] ?? 0;
  console.log(t);
  let j = 3;
  while (j > 0) { j--; }
  do { j++; } while (j < 2);
  console.log(j);
}
main();
