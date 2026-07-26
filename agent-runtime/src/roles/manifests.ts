/**
 * Concrete RoleManifests shipped by this task: the General Worker, the
 * first four specialist castes (Code, Web, Device, Mail), and the two
 * read-only/no-tool governance castes (Inspector, Memory Curator). Each
 * specialist manifest follows GENERAL_ROLE_MANIFEST's exact pattern -- a
 * resolved promptPath constant plus a frozen RoleManifest literal -- and
 * declares only the tools its job requires (see the module-level tool
 * files this package now ships: ./../tools/code-tools.ts,
 * ./../tools/web-tools.ts, ./../tools/device-tools.ts,
 * ./../tools/mail/agently-mail.ts). Inspector and Memory Curator have no
 * bespoke tool file of their own -- their actual judgment logic lives in
 * ../inspection/inspector.ts and ../memory/memory-curator.ts respectively;
 * this module only ever names the (deliberately minimal) tool set their Pi
 * Sessions may use. Further specialist roles arrive in later tasks and
 * register the same way.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { CODE_WORKER_TOOLS } from "../tools/code-tools.js";
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
 * Code Worker: Pi's own built-in tools (see ../tools/code-tools.ts -- this
 * manifest does not reimplement them, only names the exact set). Coding
 * work benefits from the deepest model tier and thinking budget this
 * package's RoleModelClass/RoleThinkingLevel scale offers.
 */
export const CODE_ROLE_PROMPT_PATH = resolveRolePromptPath("code.md");

export const CODE_ROLE_MANIFEST: RoleManifest = Object.freeze({
  id: "code",
  capabilities: ["code-editing", "terminal", "file-search"],
  tools: CODE_WORKER_TOOLS,
  promptPath: CODE_ROLE_PROMPT_PATH,
  modelClass: "deep",
  thinkingLevel: "high",
  lifecycle: "resident",
});

/** Web Scout: only its two custom tools (../tools/web-tools.ts) -- no filesystem/terminal access. */
export const WEB_ROLE_PROMPT_PATH = resolveRolePromptPath("web.md");

export const WEB_ROLE_MANIFEST: RoleManifest = Object.freeze({
  id: "web",
  capabilities: ["web-search", "web-fetch"],
  tools: ["web_search", "web_fetch"],
  promptPath: WEB_ROLE_PROMPT_PATH,
  modelClass: "balanced",
  thinkingLevel: "medium",
  lifecycle: "resident",
});

/**
 * Device Steward: only its status/service-control tools (../tools/device-
 * tools.ts) -- deliberately no `write`/`edit` (or any filesystem/terminal
 * tool at all). Device status/service actions are simple and deterministic
 * enough for the cheapest model tier.
 */
export const DEVICE_ROLE_PROMPT_PATH = resolveRolePromptPath("device.md");

export const DEVICE_ROLE_MANIFEST: RoleManifest = Object.freeze({
  id: "device",
  capabilities: ["device-status", "service-control"],
  tools: ["device_status", "service_action"],
  promptPath: DEVICE_ROLE_PROMPT_PATH,
  modelClass: "fast",
  thinkingLevel: "low",
  lifecycle: "resident",
});

/** Mail Worker: only its agently-cli-backed mail operations (../tools/mail/agently-mail.ts) -- deliberately no `bash` (or any other terminal/filesystem tool). */
export const MAIL_ROLE_PROMPT_PATH = resolveRolePromptPath("mail.md");

export const MAIL_ROLE_MANIFEST: RoleManifest = Object.freeze({
  id: "mail",
  capabilities: ["mail-search", "mail-read", "mail-send", "mail-triage"],
  tools: [
    "mail_search",
    "mail_read",
    "mail_watch",
    "mail_send",
    "mail_reply",
    "mail_forward",
    "mail_trash",
    "mail_download",
  ],
  promptPath: MAIL_ROLE_PROMPT_PATH,
  modelClass: "balanced",
  thinkingLevel: "medium",
  lifecycle: "resident",
});

/**
 * Inspector: read-only verification of another role's claimed task outcome.
 * The actual judgment logic (never LLM, never persisted chain-of-thought)
 * lives in ../inspection/inspector.ts; this manifest only gives the
 * Inspector role's Pi Session the tools it needs to gather evidence.
 * Deliberately no write/edit/bash -- an Inspector that could change state
 * could also contaminate the evidence it is supposed to be judging.
 */
export const INSPECTOR_ROLE_PROMPT_PATH = resolveRolePromptPath("inspector.md");

export const INSPECTOR_ROLE_MANIFEST: RoleManifest = Object.freeze({
  id: "inspector",
  capabilities: ["result-verification", "evidence-review"],
  tools: ["read", "grep", "find", "ls"],
  promptPath: INSPECTOR_ROLE_PROMPT_PATH,
  modelClass: "balanced",
  thinkingLevel: "medium",
  lifecycle: "resident",
});

/**
 * Memory Curator: decides what becomes permanent Personal Memory. The
 * actual filtering logic lives in ../memory/memory-curator.ts; this
 * manifest just registers the role. It needs no tool at all -- it only
 * ever judges structured events it is handed, never goes looking for more
 * content itself.
 */
export const MEMORY_ROLE_PROMPT_PATH = resolveRolePromptPath("memory.md");

export const MEMORY_ROLE_MANIFEST: RoleManifest = Object.freeze({
  id: "memory",
  capabilities: ["memory-curation", "preference-tracking"],
  tools: [],
  promptPath: MEMORY_ROLE_PROMPT_PATH,
  modelClass: "fast",
  thinkingLevel: "low",
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
