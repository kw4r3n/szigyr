// Single source for the provisional CLI name. package.json names cannot import this;
// names.test.ts checks they agree.
export const CLI_NAME = "szigyr";
export const SOURCE_EXT = ".szigyr";
export const CACHE_DIR = `.${CLI_NAME}-cache`;
export const PACKAGE_SCOPE = `@${CLI_NAME}`;
export const PACKAGE_NAMES = ["compiler", "runtime-js", "std"].map((p) => `${PACKAGE_SCOPE}/${p}`);
/** Directive prefixes and runtime identifiers derive from here too. */
export const RUNTIME_GLOBAL = `__${CLI_NAME}_rt`;
