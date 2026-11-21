// expect: ok
// stage: 2
// open-question: Q058
// open-question: Q188
function sum(s: Ref<Slice<f32>>): f32 {
  "use rt";
  let acc: f32 = 0;
  for (let i: usize = 0; i < s.length; i += 1) {
    acc += s[i];
  }
  return acc;
}

function touch(a: Ref<Arena>, b: ArenaBuf<f32>): f32 {
  "use rt";
  return sum(a.view(b));
}

function copyInto(dst: Mut<Slice<f32>>, src: Ref<Slice<f32>>): void {
  "use rt";
  for (let i: usize = 0; i < dst.length; i += 1) {
    dst[i] = src[i];
  }
}

test("arena traps", (t: Test) => {
  t.traps("T012", () => {
    const a = Arena.create(TestAlloc.create(), 64);
    const b = a.alloc<f32>(4, 1);
    if (b !== null) {
      a.reset();
      t.eq(touch(a, b), 0);
    }
  });
  t.traps("T012", () => {
    const a = Arena.create(TestAlloc.create(), 64);
    const other = Arena.create(TestAlloc.create(), 64);
    const ob = other.alloc<f32>(2, 3);
    if (ob !== null) {
      t.eq(touch(a, ob), 0);
    }
  });
  t.traps("T013", () => {
    const a = Arena.create(TestAlloc.create(), 64);
    const c = a.alloc<f32>(4, 2);
    if (c !== null) {
      copyInto(a.view(c), a.view(c));
    }
  });
});
