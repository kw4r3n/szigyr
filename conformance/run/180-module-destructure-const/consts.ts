export const { width, height }: { readonly width: i32; readonly height: i32 } = { width: 640, height: 480 };
const { gain, offset }: { readonly gain: f64; readonly offset: f64 } = { gain: 0.5, offset: 2 };
type Pt = { readonly x: i32; readonly y: i32 };
export const { x: px, y: py }: Pt = { x: 3, y: 4 };
export const { flag, name }: { readonly flag: boolean; readonly name: string } = { flag: true, name: "mod" };
export { gain };
export function scaled(v: f64): f64 {
  "use rt";
  return v * gain + offset;
}
export function sum(): i32 {
  return width + height + px + py;
}
