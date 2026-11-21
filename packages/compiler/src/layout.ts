// Byte layout of non-numeric Vec / Slice elements (SPEC §10.2, D105), shared by the JS translator and the C backend.
// The runtime receives the computed layout as JSON and never recomputes offsets.
import { isBool, isCopy, isNull, isTaggedUnion, kindOf, nonNull, type NumName, type Type } from "./types.ts";

export type Lay =
  | { t: "num"; n: NumName; z: number; a: number }
  | { t: "bool"; z: 1; a: 1 }
  | { t: "null"; z: 1; a: 1 }
  | { t: "lit"; v: string[]; z: 4; a: 4 }
  | { t: "rec"; f: { n: string; o: number; l: Lay }[]; z: number; a: number }
  | { t: "uni"; m: Lay[]; z: number; a: number }
  | { t: "opt"; o: number; l: Lay; z: number; a: number }
  | { t: "hdl"; z: 12; a: 4 }
  | { t: "abuf"; z: 16; a: 4 };

const NUM_SIZE: Record<NumName, number> = { i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4, usize: 4, f32: 4, f64: 8 };
const up = (n: number, a: number): number => Math.ceil(n / a) * a;
const byUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The layout of a Copy element type, or undefined when `t` has none (non-Copy, type parameter, ...). `kinds`: the union's kinds for a member's `kind`. */
export function layout(t: Type, kinds?: string[]): Lay | undefined {
  if (t.k === "num") return { t: "num", n: t.name, z: NUM_SIZE[t.name], a: NUM_SIZE[t.name] };
  if (isBool(t)) return { t: "bool", z: 1, a: 1 };
  if (isNull(t)) return { t: "null", z: 1, a: 1 };
  if (t.k === "lit") return { t: "lit", v: [t.value], z: 4, a: 4 };
  if (t.k === "gen" && t.name === "Handle") return { t: "hdl", z: 12, a: 4 }; // Q188 (a): pool id, generation, index
  if (t.k === "gen" && t.name === "ArenaBuf") return { t: "abuf", z: 16, a: 4 }; // Q188 (b): arena id, generation, head byte position, length
  if (!isCopy(t)) return undefined;
  if (t.k === "record") {
    const fs = [...t.fields.filter((f) => f.name === "kind"), ...t.fields.filter((f) => f.name !== "kind")];
    let z = 0, a = 1;
    const f: { n: string; o: number; l: Lay }[] = [];
    for (const x of fs) {
      const l = x.name === "kind" && kinds ? { t: "lit" as const, v: kinds, z: 4 as const, a: 4 as const } : layout(x.type);
      if (!l) return undefined;
      z = up(z, l.a);
      f.push({ n: x.name, o: z, l });
      z += l.z;
      a = Math.max(a, l.a);
    }
    return { t: "rec", f, z: up(z, a), a };
  }
  if (t.k !== "union") return undefined;
  if (t.members.every((m) => m.k === "lit")) return { t: "lit", v: t.members.map((m) => (m as { value: string }).value).sort(byUnits), z: 4, a: 4 };
  if (isTaggedUnion(t)) {
    const ms = [...t.members].sort((x, y) => byUnits(kindOf(x)!, kindOf(y)!));
    const ks = ms.map((m) => kindOf(m)!);
    const ls = ms.map((m) => layout(m, ks));
    if (ls.some((l) => !l)) return undefined;
    const a = Math.max(...ls.map((l) => l!.a));
    return { t: "uni", m: ls as Lay[], z: up(Math.max(...ls.map((l) => l!.z)), a), a };
  }
  const n = nonNull(t);
  const l = n && layout(n);
  if (!l) return undefined;
  const o = up(1, l.a);
  return { t: "opt", o, l, z: up(o + l.z, l.a), a: l.a };
}

/** The element kind Vec.create gets at run time: a number type's name, a layout's JSON, or "other" (type parameter: a plain array, D100). */
export function elemDesc(t: Type | undefined): string {
  if (!t) return "other";
  if (t.k === "num") return t.name;
  const l = layout(t);
  return l ? JSON.stringify(l) : "other";
}
