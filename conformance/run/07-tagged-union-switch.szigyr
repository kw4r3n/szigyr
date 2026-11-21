// expect-output: circle(r=1.5) area=7.0685834705770345
// expect-output: rect(2x3.5) area=7
// expect-output: tri(b=3, h=5) area=7.5
// expect-output: scaled rect 4x7
// expect-output: total=86.27433388230814
// stage: 1
// open-question: Q014
// open-question: Q021
// open-question: Q024
// open-question: Q027
// open-question: Q059
type Shape =
  | { readonly kind: "circle"; readonly r: f64 }
  | { readonly kind: "rect"; readonly w: f64; readonly h: f64 }
  | { readonly kind: "tri"; readonly b: f64; readonly h: f64 };

function area(s: Shape): f64 {
  switch (s.kind) {
    case "circle":
      return Math.PI * s.r * s.r;
    case "rect":
      return s.w * s.h;
    case "tri":
      return s.b * s.h / 2;
  }
}

function label(s: Shape): string {
  switch (s.kind) {
    case "circle":
      return `circle(r=${s.r})`;
    case "rect":
      return `rect(${s.w}x${s.h})`;
    case "tri":
      return `tri(b=${s.b}, h=${s.h})`;
  }
}

function scale(s: Shape, k: f64): Shape {
  switch (s.kind) {
    case "circle":
      return { kind: "circle", r: s.r * k };
    case "rect":
      return { kind: "rect", w: s.w * k, h: s.h * k };
    case "tri":
      return { kind: "tri", b: s.b * k, h: s.h * k };
  }
}

export function main(sys: System): void {
  const shapes: Array<Shape> = [
    { kind: "circle", r: 1.5 },
    { kind: "rect", w: 2, h: 3.5 },
    { kind: "tri", b: 3, h: 5 },
  ];
  for (const s of shapes) {
    sys.log.info(`${label(s)} area=${area(s)}`);
  }
  let total: f64 = 0;
  for (const s of shapes) {
    const t = scale(s, 2);
    total += area(t);
    if (t.kind === "rect") {
      sys.log.info(`scaled rect ${t.w}x${t.h}`);
    }
  }
  sys.log.info(`total=${total}`);
}
