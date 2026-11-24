type Dir = "up" | "down" | "left" | "right";
function delta(d: Dir): number {
  switch (d) {
    case "up": return -1;
    case "down": return 1;
    case "left": return -10;
    case "right": return 10;
  }
}
function main(): void {
  const ds: Dir[] = ["up", "right", "down"];
  let t = 0;
  for (const d of ds) t += delta(d);
  console.log(t);
}
main();
