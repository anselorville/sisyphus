import { describe, expect, it } from "vitest";

import {
  CODE_ROLE_MANIFEST,
  DEVICE_ROLE_MANIFEST,
  MAIL_ROLE_MANIFEST,
  WEB_ROLE_MANIFEST,
} from "../../src/roles/manifests.js";
import type { RoleManifest } from "../../src/roles/types.js";

/**
 * Asserts each of the four first-release worker castes gets exactly the
 * tools its job requires -- no incidental over-provisioning. Does not test
 * an "Inspector" role: that caste is built in a later task, not this one.
 */
describe("baseline worker role manifests: least-privilege tool sets", () => {
  it("Code Worker gets exactly Pi's built-in coding tools", () => {
    expect([...CODE_ROLE_MANIFEST.tools].sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"].sort());
  });

  it("Web Scout gets exactly its two custom tools and nothing filesystem/terminal-shaped", () => {
    expect([...WEB_ROLE_MANIFEST.tools].sort()).toEqual(["web_fetch", "web_search"].sort());
    expect(WEB_ROLE_MANIFEST.tools).not.toContain("bash");
    expect(WEB_ROLE_MANIFEST.tools).not.toContain("write");
  });

  it("Device Steward gets exactly device_status and service_action -- never write or edit", () => {
    expect([...DEVICE_ROLE_MANIFEST.tools].sort()).toEqual(["device_status", "service_action"].sort());
    expect(DEVICE_ROLE_MANIFEST.tools).not.toContain("write");
    expect(DEVICE_ROLE_MANIFEST.tools).not.toContain("edit");
    expect(DEVICE_ROLE_MANIFEST.tools).not.toContain("bash");
  });

  it("Mail Worker gets exactly its agently-cli mail operations -- never bash", () => {
    expect([...MAIL_ROLE_MANIFEST.tools].sort()).toEqual(
      ["mail_download", "mail_forward", "mail_read", "mail_reply", "mail_search", "mail_send", "mail_trash", "mail_watch"].sort(),
    );
    expect(MAIL_ROLE_MANIFEST.tools).not.toContain("bash");
    expect(MAIL_ROLE_MANIFEST.tools).not.toContain("write");
    expect(MAIL_ROLE_MANIFEST.tools).not.toContain("edit");
  });

  it("every new manifest has a distinct id, a matching prompt file, and declared capabilities", () => {
    const manifests: readonly RoleManifest[] = [CODE_ROLE_MANIFEST, WEB_ROLE_MANIFEST, DEVICE_ROLE_MANIFEST, MAIL_ROLE_MANIFEST];

    const ids = manifests.map((manifest) => manifest.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const manifest of manifests) {
      expect(manifest.capabilities.length).toBeGreaterThan(0);
      expect(manifest.promptPath.endsWith(`/resources/roles/${manifest.id}.md`)).toBe(true);
    }
  });
});
