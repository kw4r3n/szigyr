// expect-output: null
// expect-output: 7
// expect-output: null
// expect-output: 1 null
// expect-output: 0 null
// expect-output: 2 null
// expect-output: 1 null
// expect-output: 3 null
// expect-output: 7
// expect-output: 5
// expect-output: null
// stage: 1
// open-question: Q025
// open-question: Q027
// open-question: Q031
// open-question: Q032
// open-question: Q059
// open-question: Q029
function showI(x: i32 | null): string {
  return x === null ? "null" : `${x}`;
}

function showU(x: usize | null): string {
  return x === null ? "null" : `${x}`;
}

function len(s: string | null): usize | null {
  return s?.length;
}

export function main(sys: System): void {
  const xs: Array<i32> = [];
  sys.log.info(showI(xs.pop()));
  xs.push(5);
  xs.push(7);
  sys.log.info(showI(xs.find((x: i32): boolean => x > 5)));
  sys.log.info(showI(xs.find((x: i32): boolean => x > 10)));
  sys.log.info(`${showU(xs.indexOf(7))} ${showU(xs.indexOf(9))}`);
  sys.log.info(`${showU(xs.findIndex((x: i32): boolean => x === 5))} ${showU(xs.findIndex((x: i32): boolean => x > 100))}`);
  const word: string = "hello";
  sys.log.info(`${showU(word.indexOf("l"))} ${showU(word.indexOf("z"))}`);
  const m = new Map<string, i32>();
  m.set("k", 1);
  sys.log.info(`${showI(m.get("k"))} ${showI(m.get("nope"))}`);
  sys.log.info(`${showU(len("abc"))} ${showU(len(null))}`);
  sys.log.info(showI(xs.pop()));
  sys.log.info(showI(xs.pop()));
  sys.log.info(showI(xs.pop()));
}
