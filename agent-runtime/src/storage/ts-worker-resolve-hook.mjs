// Plain JavaScript on purpose -- this file is preloaded via `--import` into
// a brand-new worker_threads Node instance (see resolveWorkerEntry() in
// ./database.ts) *before* db-worker.ts runs, so it must not itself require
// any transpilation step.
//
// Why this exists: the rest of this repo is compiled with TypeScript's
// NodeNext module resolution, which requires writing the *emitted* `.js`
// extension in relative import specifiers even though only the `.ts` source
// exists on disk today (see src/config.ts, src/protocol/*.ts, etc. -- every
// import already follows this convention). `tsc` resolves that correctly at
// build time. Node's own native TypeScript support (unflagged since Node
// 23.6, used here to run db-worker.ts directly with no build step) strips
// types but does *not* know about that `.js` -> `.ts` mapping, so
// `import ... from "./migrations.js"` 404s when only migrations.ts exists.
//
// This hook fixes exactly that one gap: if a relative `./x.js` specifier
// can't be found but a sibling `./x.ts` exists, resolve to the `.ts` file
// instead (Node's native stripping then takes over as normal). It never
// touches bare package specifiers (e.g. "better-sqlite3") or node: built-ins,
// and it only runs inside the worker thread's own Node instance -- the
// parent (main) thread's module resolution is completely untouched.
//
// Once `npm run build` has produced dist/storage/db-worker.js, this hook is
// never loaded at all: resolveWorkerEntry() prefers the compiled sibling
// whenever it exists.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
  if (isRelative && specifier.endsWith(".js") && context.parentURL) {
    const tsSpecifier = `${specifier.slice(0, -".js".length)}.ts`;
    const candidateURL = new URL(tsSpecifier, context.parentURL);
    if (existsSync(fileURLToPath(candidateURL))) {
      return nextResolve(tsSpecifier, context);
    }
  }
  return nextResolve(specifier, context);
}
