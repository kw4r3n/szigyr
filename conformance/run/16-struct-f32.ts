// expect-output: 0.4000000059604645 0.6000000238418579
// expect-output: 1.2000000476837158 1.8000000715255737
// expect-output: 0.11000000685453415
// expect-output: true 0.20000000298023224
// expect-output: 0.800000011920929
// stage: 2
// open-question: Q014
// open-question: Q015
// open-question: Q027
// open-question: Q059
// open-question: Q047
type V2 = Struct<{ readonly x: f32; readonly y: f32 }>;

function add(a: V2, b: V2): V2 {
  "use rt";
  return { x: a.x + b.x, y: a.y + b.y };
}

function scale(a: V2, k: f32): V2 {
  "use rt";
  return { x: a.x * k, y: a.y * k };
}

function dot(a: V2, b: V2): f32 {
  "use rt";
  return a.x * b.x + a.y * b.y;
}

export function main(sys: System): void {
  const a: V2 = { x: 0.1, y: 0.2 };
  const b: V2 = { x: 0.3, y: 0.4 };
  const c = add(a, b);
  sys.log.info(`${c.x} ${c.y}`);
  const d = scale(c, 3);
  sys.log.info(`${d.x} ${d.y}`);
  sys.log.info(`${dot(a, b)}`);
  const e = a;
  sys.log.info(`${e.x === a.x} ${e.y}`);
  const pts: Array<V2> = [a, b, c];
  let acc: f32 = 0;
  for (const p of pts) {
    acc += p.x;
  }
  sys.log.info(`${acc}`);
}
