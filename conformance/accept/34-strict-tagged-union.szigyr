// expect: ok
// stage: 2
// open-question: Q043
type Op =
  | { readonly kind: "add"; readonly n: i32 }
  | { readonly kind: "neg" };

export function applyOp(op: Op, x: i32): i32 {
  "use owned";
  switch (op.kind) {
    case "add": return x + op.n;
    case "neg": return -x;
  }
}

export function applyAll(a: Op, b: Op, x: i32): i32 {
  "use owned";
  return applyOp(b, applyOp(a, x));
}

test("strict tagged union", (t: Test) => {
  t.eq(applyOp({ kind: "add", n: 2 }, 5), 7);
  t.eq(applyAll({ kind: "neg" }, { kind: "add", n: 1 }, 5), -4);
});
