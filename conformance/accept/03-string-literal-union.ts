// expect: ok
// stage: 1
// open-question: Q024
type Color = "red" | "green" | "blue";

export function hex(c: Color): string {
  switch (c) {
    case "red": return "#f00";
    case "green": return "#0f0";
    case "blue": return "#00f";
  }
}

export function isWarm(c: Color): boolean {
  return c === "red";
}

export function next(c: Color): Color {
  if (c === "red") {
    return "green";
  }
  if (c === "green") {
    return "blue";
  }
  return "red";
}

export function label(c: Color): string {
  switch (c) {
    case "red": return "R";
    default: return "other";
  }
}

test("colors", (t: Test) => {
  t.eq(hex("green"), "#0f0");
  t.eq(next("blue"), "red");
  t.ok(isWarm("red"));
  t.eq(label("blue"), "other");
});
