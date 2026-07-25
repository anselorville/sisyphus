/**
 * Concrete RoleManifests shipped by this task. Only "general" exists so
 * far; specialist roles (code, mail, web, device, ...) are built in later
 * tasks and registered the same way.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import type { RoleManifest } from "./types.js";

/**
 * Resolves a path under resources/roles/ relative to this module rather
 * than process.cwd(), so manifest promptPaths are correct whether this
 * module runs from source (src/roles/) or compiled output (dist/roles/) --
 * both sit exactly two directories below the package root, where
 * resources/ lives.
 */
export function resolveRolePromptPath(fileName: string): string {
  return path.join(import.meta.dirname, "../../resources/roles", fileName);
}

export const GENERAL_ROLE_PROMPT_PATH = resolveRolePromptPath("general.md");

export const GENERAL_ROLE_MANIFEST: RoleManifest = Object.freeze({
  id: "general",
  capabilities: ["qa", "task-clarification", "delegation"],
  tools: ["read"],
  promptPath: GENERAL_ROLE_PROMPT_PATH,
  modelClass: "balanced",
  thinkingLevel: "medium",
  lifecycle: "resident",
});

/**
 * Reads a role's system-prompt fragment from disk. Called lazily, at Pi
 * Session construction time rather than at manifest-definition time, so
 * code that only ever exercises a fake PiSessionProvider (all of this
 * task's unit tests) never needs the file to actually exist.
 */
export function loadRolePrompt(promptPath: string): string {
  return readFileSync(promptPath, "utf8");
}
