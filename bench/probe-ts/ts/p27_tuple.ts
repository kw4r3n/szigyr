function divmod(a: number, b: number): [number, number] {
  return [Math.floor(a / b), a % b];
}
function minmax(xs: number[]): readonly [number, number] {
  return [Math.min(...xs), Math.max(...xs)];
}
function main(): void {
  const [q, r] = divmod(17, 5);
  console.log(q, r);
  const mm = minmax([3, 1, 2]);
  console.log(mm[0], mm[1]);
  const pairs: [string, number][] = [["a", 1], ["b", 2]];
  for (const [k, v] of pairs) console.log(k, v);
}
main();
