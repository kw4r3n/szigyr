// expect: E4002 @ 10:19
// stage: 3
// open-question: Q229
function count<T>(v: Ref<Vec<T>>): usize {
  "use owned";
  return v.length;
}
export function main(sys: System): void {
  const v = Vec.create<null>(sys.alloc, 2);
  sys.log.info(`${count(v)}`);
}
