// expect: ok
// stage: 2
function sumVec(v: Ref<Vec<usize>>): usize {
  "use owned";
  let s: usize = 0;
  for (let i: usize = 0; i < v.length; i += 1) {
    s += v[i];
  }
  return s;
}

// 受け手の v と実引数の v.length は、Copy 値の評価が終わった時点で借用が終わる
export function pushLen(v: Mut<Vec<usize>>): void {
  "use owned";
  v.push(v.length);
}

export function pushSum(v: Mut<Vec<usize>>): usize {
  "use owned";
  const s = sumVec(v);
  v.push(s);
  pushLen(v);
  return s;
}

test("mut to ref", (t: Test) => {
  const v = Vec.create<usize>(TestAlloc.create(), 4);
  pushLen(v);
  pushLen(v);
  pushLen(v);
  t.eq(pushSum(v), 3);
  t.eq(v.length, 5);
  t.eq(v[4], 4);
});
