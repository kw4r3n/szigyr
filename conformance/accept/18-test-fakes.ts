// expect: ok
// stage: 1
// open-question: Q038
function greet(log: Log, clock: Clock): void {
  log.info(`t=${clock.nowMs()}`);
}

function save(fs: Fs, path: string, text: string): boolean {
  const r = fs.writeText(path, text);
  return r.kind === "ok";
}

test("greet logs time", (t: Test) => {
  const log = MemoryLog.create();
  const clock = FakeClock.create(1500);
  greet(log, clock);
  const es = log.entries();
  t.eq(es.length, 1);
  t.eq(es[0].message, "t=1500");
  clock.advance(500);
  t.eq(clock.nowMs(), 2000);
});

test("fs roundtrip", (t: Test) => {
  const fs = FakeFs.create();
  t.ok(save(fs, "a.txt", "hi"));
  const r = fs.readText("a.txt");
  if (r.kind === "ok") {
    t.eq(r.value, "hi");
  } else {
    t.ok(false);
  }
  t.ok(fs.readText("nope").kind === "err");
});

test("seeded random", (t: Test) => {
  const rng = SeededRandom.create(42);
  const x = rng.nextF64();
  t.ok(x >= 0 && x < 1);
});
