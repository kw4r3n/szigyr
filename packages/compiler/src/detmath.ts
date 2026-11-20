// Q191 (§12): the bundled DetMath module. The compiler adds packages/std/detmath.ts to the program
// under a name users cannot write when a file uses `DetMath.<name>`; importing it is E7001.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RUNTIME_GLOBAL } from "./names.ts";

export const DETMATH_PATH = realpathSync(fileURLToPath(new URL("../../std/detmath.ts", import.meta.url))); // canonical, like every module path (Q253)

/** The ten public DetMath functions (§12): unary (f64) => f64, then the two binary ones. */
export const DETMATH_UNARY = ["sin", "cos", "tan", "atan", "exp", "log", "log10", "tanh"];
export const DETMATH_BINARY = ["atan2", "pow"];

/** The binding a DetMath member is imported under in generated JS: a name users cannot write. */
export const dmBinding = (name: string): string => `${RUNTIME_GLOBAL}_dm_${name}`;
