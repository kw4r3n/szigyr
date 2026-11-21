// expect: E3004 @ 10:15
// stage: 3
function first(s: Ref<Slice<i32>>): i32 {
  "use rt";
  return s[0];
}
export function f(p: Ptr<i32>): i32 {
  "use owned";
  "use unsafe";
  const s = p.slice(2);
  return first(p.slice(2));
}
