// expect: ok
// stage: 2
// open-question: Q053
// open-question: Q047
type V3 = Struct<{ readonly x: f32; readonly y: f32; readonly z: f32 }>;
type Seg = Struct<{ readonly a: V3; readonly b: V3 }>;

export function dot(a: V3, b: V3): f32 {
  "use owned";
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function scaled(a: V3, k: f32): V3 {
  "use owned";
  const r: V3 = { x: a.x * k, y: a.y * k, z: a.z * k };
  return r;
}

export function flatten(a: V3): V3 {
  "use owned";
  const r: V3 = { ...a, z: 0 };
  return r;
}

// Copy: a は b に複製されたあとも使える
export function useTwice(a: V3): f32 {
  "use owned";
  const b = a;
  return dot(a, b);
}

export function lenSq(s: Seg): f32 {
  "use owned";
  const d: V3 = { x: s.b.x - s.a.x, y: s.b.y - s.a.y, z: s.b.z - s.a.z };
  return dot(d, d);
}

test("struct copy", (t: Test) => {
  const s: Seg = { a: { x: 0, y: 0, z: 0 }, b: { x: 1, y: 2, z: 2 } };
  t.eq(lenSq(s), 9);
  t.eq(lenSq(s), 9);
  const v: V3 = { x: 1, y: 2, z: 3 };
  t.eq(useTwice(v), 14);
  t.eq(scaled(v, 2), { x: 2, y: 4, z: 6 });
  t.eq(flatten(v), { x: 1, y: 2, z: 0 });
});
