/**
 * Resolves a role's declared `RoleManifest.modelClass` ("fast"/"balanced"/
 * "deep") to a concrete `Model` via the configured RoleModelClassRouting
 * (../config.ts) and a live model catalog.
 *
 * Closes the gap createDefaultPiSessionProvider() previously left open:
 * every role's Pi Session used to fall through to whatever
 * pi-ai/pi-coding-agent's own SDK default happened to resolve to,
 * regardless of its declared tier (see ./session-manager.ts's history).
 */

import type { Api, Model } from "@earendil-works/pi-ai";

import type { RoleModelClass, RoleModelClassRouting, RoleModelRef } from "./types.js";

/**
 * Minimal structural slice of pi-ai's `Models` collection (and therefore of
 * `@earendil-works/pi-coding-agent`'s `ModelRuntime`, which implements it)
 * this module depends on -- mirrors ./types.ts's PiSession "minimal slice"
 * pattern. A real ModelRuntime instance satisfies this as-is; tests inject
 * a fake instead of touching a live Pi backend/network.
 */
export interface ModelCatalog {
  /**
   * Models whose provider currently has complete, working auth
   * configuration -- never merely "known to the static catalog" (see
   * pi-ai's `Models.getAvailable()` doc). Resolving through this rather
   * than a raw catalog lookup means a misconfigured/unauthenticated
   * provider surfaces as an UnresolvedRoleModelError instead of silently
   * building a session that will fail on first real request.
   */
  getAvailable(providerId?: string): Promise<readonly Model<Api>[]>;
}

/** Thrown by resolveRoleModel() when a RoleModelClass's configured RoleModelRef names a model that isn't available: unknown id, or its provider has no working credential. */
export class UnresolvedRoleModelError extends Error {
  constructor(roleId: string, modelClass: RoleModelClass, ref: RoleModelRef) {
    super(
      `role "${roleId}"'s modelClass "${modelClass}" routes to "${ref.provider}:${ref.modelId}", but that model isn't available -- either the id is unknown or provider "${ref.provider}" has no working credential. Fix its credential, or repoint the tier via env var AGENT_RUNTIME_MODEL_${modelClass.toUpperCase()}.`,
    );
    this.name = "UnresolvedRoleModelError";
  }
}

/**
 * Resolves `modelClass` through `routing` to a RoleModelRef, confirms it
 * against `catalog.getAvailable()` (credential-checked, not just a static-
 * catalog id lookup), and returns the concrete Model. Throws
 * UnresolvedRoleModelError if the configured ref isn't actually usable.
 */
export async function resolveRoleModel(
  catalog: ModelCatalog,
  roleId: string,
  modelClass: RoleModelClass,
  routing: RoleModelClassRouting,
): Promise<Model<Api>> {
  const ref = routing[modelClass];
  const available = await catalog.getAvailable(ref.provider);
  const model = available.find((candidate) => candidate.id === ref.modelId);
  if (!model) {
    throw new UnresolvedRoleModelError(roleId, modelClass, ref);
  }
  return model;
}
