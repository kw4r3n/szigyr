// expect: ok
// stage: 3
type Point = Struct<{ x: i32; y: i32 }>;
type Bag = Struct<{ items: Vec<i32>; n: i32 }>;
type Note = { readonly text: string; readonly n: i32 };
type Shape = { readonly kind: "circle"; readonly r: f64 } | { readonly kind: "rect"; readonly w: f64; readonly h: f64 };
type Entry = (port: Port<i32, i32>) => void;

function sink(
  a: Port<i32, string>,
  b: Port<Vec<f32>, Vec<i32>>,
  c: Port<Point, Bag>,
  d: Port<Note, Shape>,
  e: Port<Handle<i32>, RingTx<i32>>,
  f: Port<RingRx<u8>, "go" | "stop">,
  g: Port<i32 | null, boolean>,
): void {}

function pass<T>(p: Port<T, i32>): void {}

export function main(sys: System): void {}
