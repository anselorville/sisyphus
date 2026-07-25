/**
 * Code Worker tool declarations.
 *
 * Unlike the Web/Device/Mail castes, the Code Worker does not get bespoke
 * custom tools -- it gets Pi SDK's own built-in tools (file read, shell,
 * edit, write, grep, find, ls) verbatim. This module does not reimplement
 * any of them; it only names the exact set the Code Worker's RoleManifest
 * requests, so ../roles/manifests.ts and this module share one source of
 * truth instead of the tool list being duplicated (and able to drift) in
 * two places.
 */

export const CODE_WORKER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export type CodeWorkerTool = (typeof CODE_WORKER_TOOLS)[number];
