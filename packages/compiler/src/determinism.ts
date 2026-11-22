// §7.3 / SPEC-v1 §7: Pure (`isDeterministic`) vs `Mutatable` classification.
import { bindTParams, subst, type FnType, type Type } from "./types.ts";
import { NONDET_GEN, NONDET_OPAQUE } from "./builtins.ts";

const UNMUTATABLE_OPAQUE = new Set(["System", "Ffi", "Js", "JsRef", "Test"]);
const UNMUTATABLE_GEN = new Set(["Ptr", "ConstPtr", "CHandle"]);

function hasForbidden(roots: readonly Type[], badLeaf: (t: Type) => boolean, rejectConstraints: boolean): boolean {
  const seen = new Set<unknown>();
  const bad = (t: Type): boolean => {
    if (badLeaf(t)) return true;
    switch (t.k) {
      case "cstruct": return true;
      case "record": return t.fields.some((f) => bad(f.type));
      case "union": return t.members.some(bad);
      case "gen": return t.args.some(bad);
      case "fn": return t.params.some(bad) || bad(t.ret);
      case "tuple": return t.elems.some(bad);
      case "resource": return bad(t.inner);
      case "class": {
        if (t.args.some(bad)) return true;
        if (seen.has(t.cls)) return false;
        seen.add(t.cls);
        const m = bindTParams(t.cls.tparams, t.args);
        const r = [...t.cls.fields.values()].some((f) => !f.static && bad(subst(f.type, m)));
        seen.delete(t.cls); // guard only the current recursion path
        return r;
      }
      case "iface": {
        if (t.args.some(bad)) return true;
        if (seen.has(t.iface)) return false;
        seen.add(t.iface);
        const m = bindTParams(t.iface.tparams, t.args);
        const r = [...t.iface.methods.values()].some((mt) => bad(subst(mt, m)));
        seen.delete(t.iface);
        return r;
      }
      case "tparam": return t.p.constraint ? (rejectConstraints || bad(t.p.constraint)) : false;
      default: return false;
    }
  };
  return roots.some(bad);
}

const badDetLeaf = (t: Type): boolean =>
  (t.k === "opaque" && NONDET_OPAQUE[t.name] === true) ||
  t.k === "fn" || t.k === "iface" || t.k === "resource" ||
  (t.k === "prim" && t.name === "unknown") ||
  (t.k === "gen" && !!NONDET_GEN[t.name]);

const badMutLeaf = (t: Type): boolean =>
  (t.k === "opaque" && UNMUTATABLE_OPAQUE.has(t.name)) ||
  (t.k === "gen" && UNMUTATABLE_GEN.has(t.name));

export function isDeterministic(sig: FnType, unsafe = false, extraTypes: readonly Type[] = []): boolean {
  return !unsafe && !hasForbidden([...sig.params, ...extraTypes], badDetLeaf, true); // §7.3 / §14: unsafe functions are never deterministic
}

/** SPEC-v1 §7: safe functions and class methods excluding System/Ffi/Js/JsRef/Test/Ptr/ConstPtr/CHandle. */
export function isMutatable(sig: FnType, unsafe = false, extraTypes: readonly Type[] = []): boolean {
  return !unsafe && !hasForbidden([...sig.params, ...extraTypes], badMutLeaf, false);
}
