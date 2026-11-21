// expect: ok
// stage: 3
type Stream = CHandle<CType<"SDL_AudioStream">>;
type Holder = Struct<{ stream: Stream; readonly n: i32 }>;

function getRaw(h: Stream): Ptr<CType<"SDL_AudioStream">> {
  "use owned";
  "use unsafe";
  return h.get();
}
export function wrap(h: Stream): Holder {
  "use owned";
  const holder: Holder = { stream: h, n: 3 };
  return holder;
}
export function boxHandle(alloc: Alloc, h: Stream): Stream {
  "use owned";
  "use unsafe";
  const p = Ptr.box(alloc, h);
  return p.unbox();
}
export function keep(cell: OwnedCell<Stream>, h: Stream): void {
  cell.put(h);
}
export function passOn(h: Stream): Stream {
  return h;
}
