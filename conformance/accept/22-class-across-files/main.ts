// expect: ok
// stage: 1
// open-question: Q022
// open-question: Q029
import { Shape } from "./shape.ts";
import { Circle, Square } from "./shapes.ts";

export function totalArea(xs: ReadonlyArray<Shape>): f64 {
  let s: f64 = 0;
  for (const x of xs) {
    s += x.area();
  }
  return s;
}

export function names(xs: ReadonlyArray<Shape>): string {
  return xs.map((x: Shape) => x.name()).join(",");
}

test("shapes across files", (t: Test) => {
  const xs: Array<Shape> = [new Square(2), new Circle(1)];
  t.eq(totalArea(xs), 4 + Math.PI);
  t.eq(names(xs), "square,circle");
});
