// expect-output: m true true false false false true false true true Infinity -Infinity NaN | o 31 Infinity -Infinity NaN
// stage: 2
// open-question: Q271
function managed(): string {
  const inf = Number.POSITIVE_INFINITY, ninf = Number.NEGATIVE_INFINITY, nan = Number.NaN;
  const a = inf > 1e308, b = ninf < -1e308;
  const fin = Number.isFinite(inf) || Number.isFinite(ninf) || Number.isFinite(nan);
  const c = Number.isNaN(nan), d = nan === nan;
  const e = -inf === ninf, f = inf + 1 === inf, g = Number.isNaN(inf - inf);
  return `m ${a} ${b} ${fin} ${Number.isNaN(inf)} ${d} ${c} ${Number.isNaN(1)} ${e} ${f && g} ${inf} ${ninf} ${nan}`;
}
function owned(): i32 {
  "use owned";
  const inf = Number.POSITIVE_INFINITY, ninf = Number.NEGATIVE_INFINITY, nan = Number.NaN;
  const z = inf - inf;
  let r: i32 = 0;
  if (inf > 1e308) r += 1;
  if (ninf < -1e308) r += 2;
  if (nan !== nan) r += 4;
  if (-inf === ninf) r += 8;
  if (inf + 1 === inf && z !== z) r += 16;
  return r;
}
function ownedInf(): f64 { "use owned"; return Number.POSITIVE_INFINITY; }
function ownedNinf(): f64 { "use owned"; return Number.NEGATIVE_INFINITY; }
function ownedNan(): f64 { "use owned"; return Number.NaN; }
export function main(sys: System): void {
  sys.log.info(`${managed()} | o ${owned()} ${ownedInf()} ${ownedNinf()} ${ownedNan()}`);
}
