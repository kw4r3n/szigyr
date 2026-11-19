// expect-output: 1 2 3 4 5 6
// stage: 1
function id<T /* a>b */>(x: T): T { return x; }
function id2</* < */ T, /* : */ U>(x: T, y: /* x: y */ U): T /* ): */ { return x; }
export function main(sys: System): void {
  const a: /* a:b */ u32 = 1;
  const b = id<u32 /* < */>(2);
  const c = id</* c: < */ u32>(3);
  const d: u32 /* ok: fine */ = 4; // trailing: colon
  const e = id<u32>/* > */(5);
  const f = id2<u32, /* > */ boolean>(6, true);
  sys.log.info(`${a} ${b} ${c} ${d} ${e} ${f}`);
}
