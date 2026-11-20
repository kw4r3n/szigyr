// §7.3 / Q062: a function is deterministic when no parameter type contains, transitively, an authority,
// a function type, an interface, `unknown` or `JsRef`. Used for E6002 (Q056) and the public query.
import { bindTParams, subst, type FnType, type Type } from "./types.ts";
import { NONDET_GEN, NONDET_OPAQUE } from "./builtins.ts";

export function isDeterministic(sig: FnType, rtUnsafe = false): boolean {
  const seen = new Set<unknown>();
  const bad = (t: Type): boolean => {
    switch (t.k) {
      case "opaque": return NONDET_OPAQUE[t.name] === true;
      case "fn": case "iface": return true;
      case "prim": return t.name === "unknown";
      case "record": return t.fields.some((f) => bad(f.type));
      case "union": return t.members.some(bad);
      case "gen": return NONDET_GEN[t.name] || t.args.some(bad); // §7.3
      case "class": {
        if (t.args.some(bad)) return true;
        if (seen.has(t.cls)) return false;
        seen.add(t.cls);
        const m = bindTParams(t.cls.tparams, t.args);
        const r = [...t.cls.fields.values()].some((f) => !f.static && bad(subst(f.type, m)));
        seen.delete(t.cls); // guard only the current recursion path
        return r;
      }
      case "tparam": return !!t.p.constraint; // constrained by an interface (§3.2)
      default: return false;
    }
  };
  return !rtUnsafe && !sig.params.some(bad); // §7.3: rt + unsafe is never deterministic
}
