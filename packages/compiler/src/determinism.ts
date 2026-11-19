// §7.3 / Q062: a function is deterministic when no parameter type contains, transitively, an authority,
// a function type, an interface, `unknown` or `JsRef`. Used for E6002 (Q056) and the public query.
import { AUTHORITIES, bindTParams, subst, type FnType, type Type } from "./types.ts";

const NONDET_OPAQUE = new Set<string>([...AUTHORITIES, "JsRef", "FakeClock", "SeededRandom", "MemoryLog", "FakeFs"]);

export function isDeterministic(sig: FnType, rtUnsafe = false): boolean {
  const seen = new Set<unknown>();
  const bad = (t: Type): boolean => {
    switch (t.k) {
      case "opaque": return NONDET_OPAQUE.has(t.name);
      case "fn": case "iface": return true;
      case "prim": return t.name === "unknown";
      case "record": return t.fields.some((f) => bad(f.type));
      case "union": return t.members.some(bad);
      case "gen": return t.name === "Ptr" || t.name === "ConstPtr" || t.name === "CHandle" || t.args.some(bad); // §7.3
      case "class": {
        if (seen.has(t.cls)) return false;
        seen.add(t.cls);
        const m = bindTParams(t.cls.tparams, t.args);
        return t.args.some(bad) || [...t.cls.fields.values()].some((f) => !f.static && bad(subst(f.type, m)));
      }
      case "tparam": return !!t.p.constraint; // constrained by an interface (§3.2)
      default: return false;
    }
  };
  return !rtUnsafe && !sig.params.some(bad); // §7.3: rt + unsafe is never deterministic
}
