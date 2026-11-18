// expect: ok
// stage: 2
import { energy, boosted } from "./dsp.ts";

export function main(sys: System): void {
  sys.log.info(`${energy(sys.alloc, 8)}`);
}

test("layers across files", (t: Test) => {
  t.eq(energy(TestAlloc.create(), 4), 1);
  t.eq(boosted(TestAlloc.create(), 4, 2), 16);
});
