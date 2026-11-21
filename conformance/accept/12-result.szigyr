// expect: ok
// stage: 1
// open-question: Q031
// open-question: Q037
// open-question: Q014
type AppError = { readonly code: "empty" | "bad"; readonly detail: string };

export function safeDiv(a: f64, b: f64): Result<f64, string> {
  if (b === 0) {
    return err("div by zero");
  }
  return ok(a / b);
}

export function sqrtOk(x: f64): Result<f64, string> {
  if (x < 0) {
    return err("negative");
  }
  return ok(Math.sqrt(x));
}

export function chain(a: f64, b: f64): Result<f64, string> {
  const q = safeDiv(a, b);
  if (q.kind === "err") {
    return err(q.error);
  }
  return sqrtOk(q.value);
}

export function digit(s: string): Result<u32, AppError> {
  if (s.length !== 1) {
    return err({ code: "bad", detail: s });
  }
  const c = s.charCodeAt(0);
  if (c < 48 || c > 57) {
    return err({ code: "bad", detail: s });
  }
  return ok(u32(c) - 48);
}

function valueOr(r: Result<f64, string>, d: f64): f64 {
  switch (r.kind) {
    case "ok": return r.value;
    case "err": return d;
  }
}

test("result", (t: Test) => {
  t.eq(valueOr(chain(16, 4), -1), 2);
  t.eq(valueOr(chain(1, 0), -1), -1);
  t.eq(valueOr(chain(-16, 4), -1), -1);
  const d = digit("7");
  if (d.kind === "ok") {
    t.eq(d.value, 7);
  } else {
    t.ok(false);
  }
  t.ok(digit("x").kind === "err");
});
