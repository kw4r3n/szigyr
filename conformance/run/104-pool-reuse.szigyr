// expect-output: vals=1 4 5
// expect-output: stale=false false len=3
// expect-output: again=6 stale4=false len=3
// stage: 2
// open-question: Q188
export function main(sys: System): void {
  const p = Pool.create<i32>(sys.alloc, 3);
  const h1 = p.insert(1);
  if (h1 === null) {
    return;
  }
  const h2 = p.insert(2);
  if (h2 === null) {
    return;
  }
  const h3 = p.insert(3);
  if (h3 === null) {
    return;
  }
  const r2 = p.remove(h2);
  const r3 = p.remove(h3);
  const h4 = p.insert(4);
  if (h4 === null) {
    return;
  }
  const h5 = p.insert(5);
  if (h5 === null) {
    return;
  }
  sys.log.info(`vals=${p.get(h1)} ${p.get(h4)} ${p.get(h5)}`);
  sys.log.info(`stale=${p.has(h2)} ${p.has(h3)} len=${p.length}`);
  const r4 = p.remove(h4);
  const h6 = p.insert(6);
  if (h6 === null) {
    return;
  }
  sys.log.info(`again=${p.get(h6)} stale4=${p.has(h4)} len=${p.length}`);
}
