// expect: ok
// stage: 1
// A-1: managed. Result と タグつき union
type Shape =
  | { readonly kind: "circle"; readonly r: f64 }
  | { readonly kind: "rect"; readonly w: f64; readonly h: f64 };

export function area(s: Shape): f64 {
  switch (s.kind) {
    case "circle": return Math.PI * s.r * s.r;
    case "rect": return s.w * s.h;
  }
}

export function isSquare(s: Shape): boolean {
  if (s.kind === "rect") {
    return s.w === s.h;
  }
  return false;
}

test("area of rect", (t: Test) => {
  t.eq(area({ kind: "rect", w: 2, h: 3 }), 6);
  t.ok(isSquare({ kind: "rect", w: 2, h: 2 }));
});
