// expect-output: 21
// stage: 2
import { STEP, inc } from "./c.ts";
function runStrict(x: i32): i32 {
  "use owned";
  return inc(x) + STEP;
}
export function main(sys: System): void {
  sys.log.info(`${runStrict(7)}`);
}
