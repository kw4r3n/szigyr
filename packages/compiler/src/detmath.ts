// Q191 (§12): the bundled DetMath module. The compiler adds packages/std/detmath.ts to the program
// under a name users cannot write when a file uses `DetMath.<name>`; importing it is E7001.
import { fileURLToPath } from "node:url";

export const DETMATH_PATH = fileURLToPath(new URL("../../std/detmath.ts", import.meta.url));

/** The ten public DetMath functions (§12): unary (f64) => f64, then the two binary ones. */
export const DETMATH_UNARY = ["sin", "cos", "tan", "atan", "exp", "log", "log10", "tanh"];
export const DETMATH_BINARY = ["atan2", "pow"];

/** The binding a DetMath member is imported under in generated JS: a name users cannot write. */
export const dmBinding = (name: string): string => `__sts_dm_${name}`;
