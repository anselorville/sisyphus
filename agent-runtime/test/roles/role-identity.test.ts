import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CODE_ROLE_MANIFEST,
  DEVICE_ROLE_MANIFEST,
  GENERAL_ROLE_MANIFEST,
  MAIL_ROLE_MANIFEST,
  WEB_ROLE_MANIFEST,
} from "../../src/roles/manifests.js";

// Roles whose words reach the user's ears. Internal roles (scribe, inspector,
// memory) never speak to the user, so they have no identity to keep.
const USER_FACING = [
  GENERAL_ROLE_MANIFEST,
  WEB_ROLE_MANIFEST,
  MAIL_ROLE_MANIFEST,
  DEVICE_ROLE_MANIFEST,
  CODE_ROLE_MANIFEST,
];

describe("user-facing role prompts", () => {
  for (const manifest of USER_FACING) {
    it(`${manifest.id}: speaks as Marcus rather than its internal role name`, () => {
      const prompt = readFileSync(manifest.promptPath, "utf8");

      expect(prompt).toContain("## Identity");
      expect(prompt).toContain("**Marcus**");
    });
  }
});
