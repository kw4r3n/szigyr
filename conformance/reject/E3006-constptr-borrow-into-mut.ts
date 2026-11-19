// expect: E3006 @ 9:8
// stage: 3
function poke(rx: Mut<RingRx<i32>>): void {
  "use rt";
}
export function go(cp: ConstPtr<RingRx<i32>>): void {
  "use owned";
  "use unsafe";
  poke(cp.borrow());
}
