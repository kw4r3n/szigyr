// expect: ok
// stage: 4
type Plain = { readonly a: i32; b: string };
type Shape =
  | { readonly kind: "dot"; readonly x: f64 }
  | { readonly kind: "box"; readonly w: f32; readonly h: f32 };
type Mode = "fast" | "safe";
type CopyS = Struct<{ readonly x: f32; readonly y: boolean }>;
type OwnedS = Struct<{ buf: Vec<i32>; readonly n: usize }>;

test("all generatable types", (t: Test) => {
  forAll((
    a: f64,
    b: f32,
    c: i8,
    d: i16,
    e: i32,
    f: u8,
    g: u16,
    h: u32,
    i: usize,
    j: boolean,
    k: string,
    l: null,
    m: "lit"
  ): void => {
    t.ok(a === a || Number.isNaN(a));
  });
  forAll((
    p: Plain,
    s: Shape,
    mo: Mode,
    opt: i32 | null,
    res: Result<i32, string>,
    arr: Array<i32>,
    ro: ReadonlyArray<string>,
    st: Set<i32>,
    mp: Map<string, i32>
  ): void => {
    t.ok(arr.length >= 0);
  });
  forAll((
    cs: CopyS,
    os: OwnedS,
    v: Vec<i32>,
    vs: Vec<CopyS>,
    vo: Vec<i32 | null>
  ): void => {
    t.ok(v.length >= 0);
  });
  forAll((
    r1: Ref<OwnedS>,
    m1: Mut<OwnedS>,
    r2: Ref<Vec<i32>>,
    m2: Mut<Vec<i32>>,
    r3: Ref<Slice<i32>>,
    m3: Mut<Slice<i32>>
  ): void => {
    t.ok(r3.length >= 0 && m3.length >= 0);
  });
});
