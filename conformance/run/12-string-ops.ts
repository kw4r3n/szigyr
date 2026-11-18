// expect-output: [Hello, World] 12 16
// expect-output: HELLO, WORLD hello, world
// expect-output: Hello|World
// expect-output: true true false
// expect-output: 4 null
// expect-output: 2 Hello | World
// expect-output: 007 ab---| HeLLo, WorLd
// expect-output: 72 A 101
// expect-output: 4 128512 55357
// expect-output: 0 x
// stage: 1
// open-question: Q019
// open-question: Q027
// open-question: Q031
// open-question: Q032
// open-question: Q059
function showU(x: usize | null): string {
  return x === null ? "null" : `${x}`;
}

function showN(x: u32 | null): string {
  return x === null ? "null" : `${x}`;
}

export function main(sys: System): void {
  const s: string = "  Hello, World  ";
  const t: string = s.trim();
  sys.log.info(`[${t}] ${t.length} ${s.length}`);
  sys.log.info(`${t.toUpperCase()} ${t.toLowerCase()}`);
  sys.log.info(`${t.slice(0, 5)}|${t.slice(7)}`);
  sys.log.info(`${t.includes("World")} ${t.startsWith("Hell")} ${t.endsWith("x")}`);
  sys.log.info(`${showU(t.indexOf("o"))} ${showU(t.indexOf("Z"))}`);
  const parts: Array<string> = t.split(", ");
  sys.log.info(`${parts.length} ${parts.join(" | ")}`);
  sys.log.info(`${"7".padStart(3, "0")} ${"ab".padEnd(5, "-")}| ${t.replaceAll("l", "L")}`);
  sys.log.info(`${t.charCodeAt(0)} ${String.fromCodePoint(65)} ${showN(t.codePointAt(1))}`);
  const e: string = "a😀b";
  sys.log.info(`${e.length} ${showN(e.codePointAt(1))} ${e.charCodeAt(1)}`);
  sys.log.info(`${"".length} ${"x".padStart(0, "y")}`);
}
