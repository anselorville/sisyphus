/**
 * In-memory lookup of RoleManifests by role id.
 *
 * Populated at startup with every known role (just "general" as of this
 * task; specialist roles arrive in later tasks) and consulted by
 * RoleSessionManager to resolve a bare roleId (e.g. from a prompt()/steer()
 * call that only names a role, not a full manifest) back to the manifest
 * its Pi Session needs to be built from.
 */

import type { RoleManifest } from "./types.js";

export class RoleManifestRegistry {
  private readonly manifests = new Map<string, RoleManifest>();

  /**
   * Registers a manifest under its `id`, replacing any manifest previously
   * registered for that id. Idempotent for the common case (RoleSessionManager.ensure()
   * re-registers on every call so id-based lookups keep working after the
   * caller only ever passed full manifests in).
   */
  register(manifest: RoleManifest): void {
    this.manifests.set(manifest.id, manifest);
  }

  get(id: string): RoleManifest | undefined {
    return this.manifests.get(id);
  }

  has(id: string): boolean {
    return this.manifests.has(id);
  }

  list(): readonly RoleManifest[] {
    return [...this.manifests.values()];
  }
}
