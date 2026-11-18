// expect: ok
// stage: 2
function consume(v: Vec<f32>): usize {
  "use owned";
  return v.length;
}

// 移動したあとの let を再代入すれば、また使える
export function replace(alloc: Alloc): usize {
  "use owned";
  let v = Vec.create<f32>(alloc, 2);
  const a = consume(v);
  v = Vec.create<f32>(alloc, 8);
  v.push(1);
  return a + consume(v);
}

// ループの外で宣言した変数を移動しても、同じ反復の中で必ず再代入するなら可
export function loopFresh(alloc: Alloc, n: usize): usize {
  "use owned";
  let total: usize = 0;
  let v = Vec.create<f32>(alloc, 4);
  for (let i: usize = 0; i < n; i += 1) {
    v.push(1);
    total += consume(v);
    v = Vec.create<f32>(alloc, 4);
  }
  return total + consume(v);
}

// 分岐の両方で移動して再代入すれば、合流後も使える
export function branchy(alloc: Alloc, flag: boolean): usize {
  "use owned";
  let v = Vec.create<f32>(alloc, 4);
  if (flag) {
    const a = consume(v);
    v = Vec.create<f32>(alloc, 4);
    v.push(1);
    v.push(f32(a));
  } else {
    v.push(2);
  }
  return consume(v);
}

test("reassign after move", (t: Test) => {
  const alloc = TestAlloc.create();
  t.eq(replace(alloc), 1);
  t.eq(loopFresh(alloc, 3), 3);
  t.eq(branchy(alloc, true), 2);
  t.eq(branchy(alloc, false), 1);
});
