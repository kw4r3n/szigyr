// expect: ok
// expect-warning: W8001 @ 8:43
// stage: 2
// open-question: Q187
import { f } from "./c.ts";
export function main(sys: System): void {
  let s: i32 = 0;
  for (let i: i32 = 0; i < 3; i += 1) s = f(s);
  sys.log.info(`${s}`);
}
