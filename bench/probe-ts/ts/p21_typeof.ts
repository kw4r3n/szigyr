function fmt(v: string | number | boolean): string {
  if (typeof v === "string") return "s:" + v.toUpperCase();
  if (typeof v === "number") return "n:" + (v + 1);
  return "b:" + (v ? "yes" : "no");
}
function main(): void {
  console.log(fmt("ab"), fmt(41), fmt(false));
}
main();
