// expect-output: 12 12
// stage: 3
// Spreading a smaller or differently-readonly Struct into an object literal copies field by field (D140).
type A = Struct<{ x: i32 }>;
type B = Struct<{ x: i32; y: i32 }>;
type RO = Struct<{ readonly x: i32; readonly y: i32 }>;
type MU = Struct<{ x: i32; y: i32 }>;
function smaller(): i32 {
  "use owned";
  const a: A = { x: 1 };
  const b: B = { ...a, y: 2 };
  return b.x * 10 + b.y;
}
function readonlyToMut(): i32 {
  "use owned";
  const ro: RO = { x: 1, y: 2 };
  const mu: MU = { ...ro };
  return mu.x * 10 + mu.y;
}
export function main(sys: System): void {
  sys.log.info(`${smaller()} ${readonlyToMut()}`);
}
