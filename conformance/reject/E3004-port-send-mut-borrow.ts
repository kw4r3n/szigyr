// expect: E3004 @ 5:10
// stage: 3
// K2 audit: a borrow cannot be moved to another isolate
export function snd(p: Port<RingRx<i32>, i32>, r: Mut<RingRx<i32>>): void {
  p.send(r);
}
