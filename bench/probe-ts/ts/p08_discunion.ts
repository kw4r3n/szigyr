type Shape =
  | { kind: "circle"; r: number }
  | { kind: "rect"; w: number; h: number };
function area(s: Shape): number {
  switch (s.kind) {
    case "circle": return Math.round(3 * s.r * s.r);
    case "rect": return s.w * s.h;
  }
}
function main(): void {
  const shapes: Shape[] = [{ kind: "circle", r: 2 }, { kind: "rect", w: 3, h: 4 }];
  for (const s of shapes) console.log(s.kind, area(s));
}
main();
