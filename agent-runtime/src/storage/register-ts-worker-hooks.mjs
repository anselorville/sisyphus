// Preloaded via `execArgv: ["--import", ...]` when spawning the database
// worker from TypeScript source (see resolveWorkerEntry() in ./database.ts).
// Node's module customization hooks must live in a separate module from the
// one that registers them, hence this tiny file: its only job is to install
// ./ts-worker-resolve-hook.mjs before db-worker.ts's own imports resolve.
import { register } from "node:module";

register("./ts-worker-resolve-hook.mjs", import.meta.url);
