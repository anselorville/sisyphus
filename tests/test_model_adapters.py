"""Tests for model adapter spec loading and schema validation.

This module tests the adapter spec loading mechanism (app/model_adapters/__init__.py)
to ensure that local and cloud adapters declare the expected tunable fields,
particularly persona/system_prompt_override support.
"""

import unittest

from app.model_adapters import _SPECS_BY_ID


class ModelAdapterSpecTests(unittest.TestCase):
    """Validate that adapter specs are loaded correctly and contain required fields."""

    def test_omlx_qwen3_5_has_system_prompt_override_field(self) -> None:
        """oMLX Qwen3.5 adapter must declare system_prompt_override textarea field.

        This field allows users to edit the LLM's persona/system prompt in the
        Model Lab UI, matching the cloud text adapter's capability.
        """
        self.assertIn("omlx:qwen3_5", _SPECS_BY_ID, msg="omlx:qwen3_5 adapter spec not loaded")
        spec = _SPECS_BY_ID["omlx:qwen3_5"]

        # Find the system_prompt_override field
        system_prompt_field = None
        for field in spec.fields:
            if field.key == "system_prompt_override":
                system_prompt_field = field
                break

        self.assertIsNotNone(
            system_prompt_field,
            msg="omlx:qwen3_5 spec missing system_prompt_override field",
        )
        self.assertEqual(
            system_prompt_field.kind,
            "textarea",
            msg="system_prompt_override must be a textarea field",
        )

    def test_cloud_text_has_system_prompt_override_field(self) -> None:
        """Cloud text adapter must have system_prompt_override field (regression guard).

        This ensures that both local and cloud text adapters stay in sync
        regarding persona support.
        """
        self.assertIn("cloud:text", _SPECS_BY_ID, msg="cloud:text adapter spec not loaded")
        spec = _SPECS_BY_ID["cloud:text"]

        # Find the system_prompt_override field
        system_prompt_field = None
        for field in spec.fields:
            if field.key == "system_prompt_override":
                system_prompt_field = field
                break

        self.assertIsNotNone(
            system_prompt_field,
            msg="cloud:text spec missing system_prompt_override field",
        )
        self.assertEqual(
            system_prompt_field.kind,
            "textarea",
            msg="system_prompt_override must be a textarea field",
        )


if __name__ == "__main__":
    unittest.main()
