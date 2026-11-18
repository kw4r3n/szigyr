// expect-output: popped=7
// expect-trap: T006 @ 9:19
// stage: 2
// open-question: Q002
// open-question: Q042
function popOrPanic(v: Mut<Vec<i32>>): i32 {
  "use owned";
  const x = v.pop();
  if (x === null) panic("empty");
  return x;
}

export function main(sys: System): void {
  const v = Vec.create<i32>(sys.alloc, 1);
  v.push(7);
  sys.log.info(`popped=${popOrPanic(v)}`);
  sys.log.info(`popped=${popOrPanic(v)}`);
}
