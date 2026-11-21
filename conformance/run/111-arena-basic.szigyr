// expect-output: flen=4 left1=48
// expect-output: ilen=3 left2=36 sum=6
// expect-output: isum=27 dlen=1 left3=24
// expect-output: full=true zero=0 left4=24
// expect-output: after=64 sum2=5 left5=56 zsum=0 zlen=0
// expect-output: empty=0 efull=true
// stage: 2
// open-question: Q188
// open-question: Q214
function sumF(s: Ref<Slice<f32>>): f32 {
  "use rt";
  let acc: f32 = 0;
  for (let i: usize = 0; i < s.length; i += 1) {
    acc += s[i];
  }
  return acc;
}

function sumI(s: Ref<Slice<i32>>): i32 {
  "use rt";
  let acc: i32 = 0;
  for (let i: usize = 0; i < s.length; i += 1) {
    acc += s[i];
  }
  return acc;
}

function setAll(s: Mut<Slice<i32>>, x: i32): void {
  "use rt";
  s.fill(x);
}

export function main(sys: System): void {
  const a = Arena.create(sys.alloc, 64);
  const f = a.alloc<f32>(4, 1.5);
  if (f === null) {
    sys.log.info("null f");
    return;
  }
  sys.log.info(`flen=${f.length} left1=${a.remaining}`);
  const i = a.alloc<i32>(3, 7);
  if (i === null) {
    sys.log.info("null i");
    return;
  }
  sys.log.info(`ilen=${i.length} left2=${a.remaining} sum=${sumF(a.view(f))}`);
  setAll(a.view(i), 9);
  const u = a.alloc<u8>(1, 3);
  const d = a.alloc<f64>(1, 2.5);
  if (u === null || d === null) {
    sys.log.info("null u/d");
    return;
  }
  sys.log.info(`isum=${sumI(a.view(i))} dlen=${d.length} left3=${a.remaining}`);
  const big = a.alloc<f64>(4, 0);
  const zero = a.alloc<f32>(0, 0);
  if (zero === null) {
    sys.log.info("null zero");
    return;
  }
  sys.log.info(`full=${big === null} zero=${zero.length} left4=${a.remaining}`);
  a.reset();
  const g = a.alloc<f32>(2, 2.5);
  const z2 = a.alloc<f32>(0, 0);
  if (g === null || z2 === null) {
    sys.log.info("null g/z2");
    return;
  }
  sys.log.info(`after=64 sum2=${sumF(a.view(g))} left5=${a.remaining} zsum=${sumF(a.view(z2))} zlen=${z2.length}`);
  const e = Arena.create(sys.alloc, 0);
  sys.log.info(`empty=${e.remaining} efull=${e.alloc<f32>(1, 1) === null}`);
}
