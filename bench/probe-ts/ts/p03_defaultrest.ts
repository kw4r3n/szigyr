function sum(base: number = 10, ...rest: number[]): number {
  let t = base;
  for (const r of rest) t += r;
  return t;
}
function tag(label: string, sep: string = ":", ...items: string[]): string {
  return label + sep + items.join(",");
}
function main(): void {
  console.log(sum());
  console.log(sum(1, 2, 3));
  console.log(tag("a"));
  console.log(tag("a", "=", "x", "y"));
}
main();
