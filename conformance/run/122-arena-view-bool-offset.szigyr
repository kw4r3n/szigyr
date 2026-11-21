// expect-output: 7
// stage: 2
function clr(s: Mut<Slice<boolean>>): void { "use rt"; s.fill(false); }
function rd(s: Ref<Slice<u32>>): u32 { "use rt"; return s[0]; }
export function main(sys: System): void {
  const a = Arena.create(sys.alloc, 64);
  const b = a.alloc<u32>(1, 7);
  const q = a.alloc<boolean>(5, true);
  if (q === null || b === null) { return; }
  clr(a.view(q));
  sys.log.info(`${rd(a.view(b))}`);
}
