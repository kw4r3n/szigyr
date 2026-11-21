// expect-output: 6 13 303 11 false 200 100000001
// stage: 2
// open-question: Q172
function e1(a: i32): i32 { "use owned"; let x: i32 = a; const y: i32 = x + (x = 5); return y; }
function g(p: i32, q: i32): i32 { "use owned"; return p * 10 + q; }
function e2(a: i32): i32 { "use owned"; let x: i32 = a; return g(x, x = 3); }
function e3(a: i32): i32 { "use owned"; let x: i32 = a; const y: i32 = x * (x += 2); return y * 100 + x; }
function e4(a: i32): i32 { "use owned"; let x: i32 = a; const y: i32 = (x = 5) + (x = 6); return y; }
function e5(a: i32): boolean { "use owned"; let x: i32 = a; return x < (x = 0); }
function e6(v: Mut<Vec<i32>>): i32 { "use owned"; let i: usize = 0; v[i] = i32(i = 2); return v[0] * 100 + v[2]; }
function e7(v: Mut<Vec<i32>>): i32 { "use owned"; let i: usize = 0; v[i] += i32(i = 100000000); return v[0]; }

export function main(sys: System): void {
  const v = Vec.create<i32>(sys.alloc, 4);
  v.push(0);
  v.push(0);
  v.push(0);
  const w = Vec.create<i32>(sys.alloc, 4);
  w.push(1);
  w.push(2);
  w.push(3);
  sys.log.info(`${e1(1)} ${e2(1)} ${e3(1)} ${e4(1)} ${e5(1)} ${e6(v)} ${e7(w)}`);
}
