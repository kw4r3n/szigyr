// expect: ok
// stage: 2
// open-question: Q040
// open-question: Q047
function dotRt(a: Ref<Slice<f32>>, b: Ref<Slice<f32>>): f32 {
  "use rt";
  requires(a.length === b.length);
  let s: f32 = 0;
  for (let i: usize = 0; i < a.length; i += 1) {
    invariant(i < a.length);
    s += a[i] * b[i];
  }
  return s;
}

// rt から rt
function twice(a: Ref<Slice<f32>>): f32 {
  "use rt";
  return dotRt(a, a) + dotRt(a, a);
}

// strict から rt。Ref の 2 つは同じ変数でよい
function normSq(v: Ref<Vec<f32>>): f32 {
  "use owned";
  return dotRt(v, v);
}

function build(alloc: Alloc): Vec<f32> {
  "use owned";
  const v = Vec.create<f32>(alloc, 2);
  v.push(3);
  v.push(4);
  return v;
}

// managed から strict と rt
export function entry(alloc: Alloc): f32 {
  const v = build(alloc);
  return normSq(v) + twice(v);
}

test("layer calls", (t: Test) => {
  t.eq(entry(TestAlloc.create()), 75);
});
