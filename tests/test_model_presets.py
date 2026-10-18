"""Tests for the Model Presets system (app/model_presets.py).

This module tests preset storage, CRUD operations, and API endpoints.
Tests use unittest.TestCase with temporary directories for isolation.
"""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.model_presets import (
    BUILTIN_PRESETS,
    BuiltinPresetError,
    PresetNotFoundError,
    create_preset,
    delete_preset,
    list_presets,
    load_presets,
    save_presets,
    update_preset,
)


class PresetStorageTests(unittest.TestCase):
    """Test preset loading, saving, and round-trip persistence."""

    def setUp(self) -> None:
        """Create a temporary directory for each test."""
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_path = Path(self.temp_dir.name)
        self.preset_file = self.temp_path / "presets.json"
        os.environ["MODEL_PRESETS_PATH"] = str(self.preset_file)

    def tearDown(self) -> None:
        """Clean up temporary directory and restore env var."""
        self.temp_dir.cleanup()
        # Restore or remove the env var so it doesn't affect other tests.
        if "MODEL_PRESETS_PATH" in os.environ:
            del os.environ["MODEL_PRESETS_PATH"]

    def test_load_missing_file_returns_empty_store(self) -> None:
        """Loading a nonexistent file returns empty store with text/speech keys."""
        store = load_presets()
        self.assertEqual(store, {"text": [], "speech": []})

    def test_load_corrupt_json_returns_empty_store(self) -> None:
        """Loading a corrupt JSON file gracefully returns empty store."""
        self.preset_file.write_text("{ this is not valid json")
        store = load_presets()
        self.assertEqual(store, {"text": [], "speech": []})

    def test_load_preserves_user_presets(self) -> None:
        """Loading persisted user presets reproduces them exactly."""
        presets_data = {
            "text": [
                {"id": "p_abc123", "name": "Custom Tone", "builtin": False, "values": {"temperature": 0.5}}
            ],
            "speech": [
                {"id": "p_def456", "name": "Custom Voice", "builtin": False, "values": {"speed": 1.1}}
            ],
        }
        self.preset_file.write_text(json.dumps(presets_data) + "\n")
        store = load_presets()
        self.assertEqual(store, presets_data)

    def test_save_presets_pretty_prints_with_trailing_newline(self) -> None:
        """Saving presets produces pretty-printed JSON with trailing newline."""
        store = {
            "text": [{"id": "p_123", "name": "Test", "builtin": False, "values": {"a": 1}}],
            "speech": [],
        }
        save_presets(store)

        content = self.preset_file.read_text()
        # Verify trailing newline
        self.assertTrue(content.endswith("\n"))
        # Verify it's valid JSON
        loaded = json.loads(content)
        self.assertEqual(loaded, store)
        # Verify it's indented (pretty-printed)
        self.assertIn("  ", content)

    def test_save_creates_parent_dirs(self) -> None:
        """Saving presets creates parent directories if they don't exist."""
        nested_path = self.temp_path / "subdir" / "nested" / "presets.json"
        os.environ["MODEL_PRESETS_PATH"] = str(nested_path)
        store = {"text": [], "speech": []}
        save_presets(store)
        self.assertTrue(nested_path.exists())


class ListPresetsTests(unittest.TestCase):
    """Test listing presets (builtin + user)."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_path = Path(self.temp_dir.name)
        self.preset_file = self.temp_path / "presets.json"
        os.environ["MODEL_PRESETS_PATH"] = str(self.preset_file)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()
        if "MODEL_PRESETS_PATH" in os.environ:
            del os.environ["MODEL_PRESETS_PATH"]

    def test_list_text_includes_builtins_first(self) -> None:
        """Listing text presets includes all builtins first."""
        presets = list_presets("text")
        # Should have at least the 5 builtin text presets.
        self.assertGreaterEqual(len(presets), 5)
        # First 5 should be builtins.
        for i in range(5):
            self.assertTrue(presets[i]["builtin"])
            self.assertTrue(presets[i]["id"].startswith("builtin:text:"))

    def test_list_speech_includes_builtins_first(self) -> None:
        """Listing speech presets includes all builtins first."""
        presets = list_presets("speech")
        # Should have at least the 5 builtin speech presets.
        self.assertGreaterEqual(len(presets), 5)
        # First 5 should be builtins.
        for i in range(5):
            self.assertTrue(presets[i]["builtin"])
            self.assertTrue(presets[i]["id"].startswith("builtin:speech:"))

    def test_list_text_with_user_presets(self) -> None:
        """User presets appear after builtins in the list."""
        user_data = {
            "text": [
                {"id": "p_custom", "name": "My Custom", "builtin": False, "values": {"temperature": 0.3}}
            ],
            "speech": [],
        }
        self.preset_file.write_text(json.dumps(user_data) + "\n")
        presets = list_presets("text")
        # Builtins + 1 user = at least 6
        self.assertGreaterEqual(len(presets), 6)
        # Last one should be the user preset.
        self.assertFalse(presets[-1]["builtin"])
        self.assertEqual(presets[-1]["id"], "p_custom")

    def test_list_invalid_capability_raises_error(self) -> None:
        """Listing an invalid capability raises ValueError."""
        with self.assertRaises(ValueError):
            list_presets("invalid_capability")

    def test_list_builtins_are_copies(self) -> None:
        """Returned builtins are copies, not references to BUILTIN_PRESETS."""
        presets = list_presets("text")
        # Modifying the returned list shouldn't affect BUILTIN_PRESETS.
        presets[0]["name"] = "Modified"
        self.assertNotEqual(BUILTIN_PRESETS["text"][0]["name"], "Modified")


class CreatePresetTests(unittest.TestCase):
    """Test creating new user presets."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_path = Path(self.temp_dir.name)
        self.preset_file = self.temp_path / "presets.json"
        os.environ["MODEL_PRESETS_PATH"] = str(self.preset_file)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()
        if "MODEL_PRESETS_PATH" in os.environ:
            del os.environ["MODEL_PRESETS_PATH"]

    def test_create_preset_generates_unique_id(self) -> None:
        """Creating a preset generates a unique ID starting with 'p_'."""
        preset = create_preset("text", "My Preset", {"temperature": 0.3})
        self.assertTrue(preset["id"].startswith("p_"))
        self.assertEqual(len(preset["id"]), len("p_") + 8)  # p_ + 8 hex chars

    def test_create_preset_persists_to_disk(self) -> None:
        """Creating a preset saves it to disk."""
        preset1 = create_preset("text", "First", {"a": 1})
        preset2 = create_preset("speech", "Second", {"b": 2})

        # Load fresh from disk.
        store = load_presets()
        self.assertEqual(len(store["text"]), 1)
        self.assertEqual(len(store["speech"]), 1)
        self.assertEqual(store["text"][0]["id"], preset1["id"])
        self.assertEqual(store["speech"][0]["id"], preset2["id"])

    def test_create_preset_invalid_capability_raises_error(self) -> None:
        """Creating a preset with invalid capability raises ValueError."""
        with self.assertRaises(ValueError):
            create_preset("invalid", "Test", {})

    def test_create_preset_empty_name_raises_error(self) -> None:
        """Creating a preset with empty name raises ValueError."""
        with self.assertRaises(ValueError):
            create_preset("text", "", {"a": 1})

    def test_create_preset_non_dict_values_raises_error(self) -> None:
        """Creating a preset with non-dict values raises ValueError."""
        with self.assertRaises(ValueError):
            create_preset("text", "Test", "not a dict")

    def test_create_preset_roundtrips_values_exactly(self) -> None:
        """Preset values are stored and retrieved exactly as provided."""
        values = {
            "temperature": 0.7,
            "instructions": "Be casual",
            "nested": {"key": "value"},
            "list": [1, 2, 3],
        }
        preset = create_preset("text", "Complex", values)
        self.assertEqual(preset["values"], values)

        # Reload from disk and verify.
        store = load_presets()
        saved_preset = store["text"][0]
        self.assertEqual(saved_preset["values"], values)

    def test_create_multiple_presets_accumulate(self) -> None:
        """Creating multiple presets adds to the store, not replaces it."""
        p1 = create_preset("text", "First", {})
        p2 = create_preset("text", "Second", {})
        store = load_presets()
        self.assertEqual(len(store["text"]), 2)
        self.assertEqual(store["text"][0]["id"], p1["id"])
        self.assertEqual(store["text"][1]["id"], p2["id"])


class UpdatePresetTests(unittest.TestCase):
    """Test updating existing presets."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_path = Path(self.temp_dir.name)
        self.preset_file = self.temp_path / "presets.json"
        os.environ["MODEL_PRESETS_PATH"] = str(self.preset_file)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()
        if "MODEL_PRESETS_PATH" in os.environ:
            del os.environ["MODEL_PRESETS_PATH"]

    def test_update_preset_name(self) -> None:
        """Updating a preset's name changes it in storage."""
        preset = create_preset("text", "Original", {"a": 1})
        updated = update_preset(preset["id"], name="Updated")
        self.assertEqual(updated["name"], "Updated")
        self.assertEqual(updated["values"], {"a": 1})

        # Verify in storage.
        store = load_presets()
        self.assertEqual(store["text"][0]["name"], "Updated")

    def test_update_preset_values(self) -> None:
        """Updating a preset's values changes them in storage."""
        preset = create_preset("text", "Test", {"a": 1})
        new_values = {"a": 2, "b": 3}
        updated = update_preset(preset["id"], values=new_values)
        self.assertEqual(updated["values"], new_values)

        store = load_presets()
        self.assertEqual(store["text"][0]["values"], new_values)

    def test_update_preset_both_name_and_values(self) -> None:
        """Updating both name and values works correctly."""
        preset = create_preset("speech", "Old", {"speed": 1.0})
        updated = update_preset(preset["id"], name="New", values={"speed": 1.2})
        self.assertEqual(updated["name"], "New")
        self.assertEqual(updated["values"], {"speed": 1.2})

    def test_update_builtin_preset_raises_error(self) -> None:
        """Attempting to update a builtin preset raises BuiltinPresetError."""
        builtin_id = "builtin:text:default"
        with self.assertRaises(BuiltinPresetError):
            update_preset(builtin_id, name="Modified")

    def test_update_unknown_preset_raises_error(self) -> None:
        """Attempting to update a nonexistent preset raises PresetNotFoundError."""
        with self.assertRaises(PresetNotFoundError):
            update_preset("p_nonexistent", name="Test")

    def test_update_preset_empty_name_raises_error(self) -> None:
        """Updating a preset with an empty name raises ValueError."""
        preset = create_preset("text", "Test", {})
        with self.assertRaises(ValueError):
            update_preset(preset["id"], name="")

    def test_update_preset_non_dict_values_raises_error(self) -> None:
        """Updating a preset with non-dict values raises ValueError."""
        preset = create_preset("text", "Test", {})
        with self.assertRaises(ValueError):
            update_preset(preset["id"], values="not a dict")


class DeletePresetTests(unittest.TestCase):
    """Test deleting presets."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_path = Path(self.temp_dir.name)
        self.preset_file = self.temp_path / "presets.json"
        os.environ["MODEL_PRESETS_PATH"] = str(self.preset_file)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()
        if "MODEL_PRESETS_PATH" in os.environ:
            del os.environ["MODEL_PRESETS_PATH"]

    def test_delete_user_preset(self) -> None:
        """Deleting a user preset removes it from storage."""
        preset = create_preset("text", "To Delete", {})
        delete_preset(preset["id"])

        store = load_presets()
        self.assertEqual(len(store["text"]), 0)

    def test_delete_builtin_preset_raises_error(self) -> None:
        """Attempting to delete a builtin preset raises BuiltinPresetError."""
        with self.assertRaises(BuiltinPresetError):
            delete_preset("builtin:text:default")

    def test_delete_unknown_preset_raises_error(self) -> None:
        """Attempting to delete a nonexistent preset raises PresetNotFoundError."""
        with self.assertRaises(PresetNotFoundError):
            delete_preset("p_nonexistent")

    def test_delete_multiple_presets_independently(self) -> None:
        """Deleting one preset doesn't affect others."""
        p1 = create_preset("text", "First", {})
        p2 = create_preset("text", "Second", {})
        p3 = create_preset("text", "Third", {})

        delete_preset(p2["id"])

        store = load_presets()
        ids = [p["id"] for p in store["text"]]
        self.assertIn(p1["id"], ids)
        self.assertNotIn(p2["id"], ids)
        self.assertIn(p3["id"], ids)


class APIEndpointTests(unittest.TestCase):
    """Test the FastAPI endpoints for presets.

    Uses fastapi.testclient.TestClient if available.
    """

    @classmethod
    def setUpClass(cls) -> None:
        """Import TestClient only once, at class setup."""
        try:
            from fastapi.testclient import TestClient

            cls.TestClient = TestClient
            cls.has_testclient = True
        except ImportError:
            cls.has_testclient = False

    def setUp(self) -> None:
        """Set up test client and temporary preset file."""
        if not self.has_testclient:
            self.skipTest("FastAPI TestClient not available")

        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_path = Path(self.temp_dir.name)
        self.preset_file = self.temp_path / "presets.json"
        os.environ["MODEL_PRESETS_PATH"] = str(self.preset_file)

        from app.server import app

        self.client = self.TestClient(app)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()
        if "MODEL_PRESETS_PATH" in os.environ:
            del os.environ["MODEL_PRESETS_PATH"]

    def test_get_presets_text(self) -> None:
        """GET /api/model-lab/presets?capability=text returns text presets."""
        response = self.client.get("/api/model-lab/presets?capability=text")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("presets", data)
        presets = data["presets"]
        # Should have at least the 5 builtin text presets.
        self.assertGreaterEqual(len(presets), 5)
        # First should be builtin.
        self.assertTrue(presets[0]["builtin"])

    def test_get_presets_speech(self) -> None:
        """GET /api/model-lab/presets?capability=speech returns speech presets."""
        response = self.client.get("/api/model-lab/presets?capability=speech")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("presets", data)
        presets = data["presets"]
        # Should have at least the 5 builtin speech presets.
        self.assertGreaterEqual(len(presets), 5)

    def test_get_presets_invalid_capability(self) -> None:
        """GET with invalid capability returns 400."""
        response = self.client.get("/api/model-lab/presets?capability=invalid")
        self.assertEqual(response.status_code, 400)

    def test_post_create_preset(self) -> None:
        """POST /api/model-lab/presets creates a new preset."""
        response = self.client.post(
            "/api/model-lab/presets",
            json={"capability": "text", "name": "My Preset", "values": {"temperature": 0.5}},
        )
        self.assertEqual(response.status_code, 201)
        preset = response.json()
        self.assertTrue(preset["id"].startswith("p_"))
        self.assertEqual(preset["name"], "My Preset")
        self.assertFalse(preset["builtin"])
        self.assertEqual(preset["values"], {"temperature": 0.5})

    def test_post_create_preset_invalid_capability(self) -> None:
        """POST with invalid capability returns 400."""
        response = self.client.post(
            "/api/model-lab/presets",
            json={"capability": "invalid", "name": "Test", "values": {}},
        )
        self.assertEqual(response.status_code, 400)

    def test_post_create_preset_empty_name(self) -> None:
        """POST with empty name returns 400."""
        response = self.client.post(
            "/api/model-lab/presets",
            json={"capability": "text", "name": "", "values": {}},
        )
        self.assertEqual(response.status_code, 400)

    def test_post_create_preset_non_dict_values(self) -> None:
        """POST with non-dict values returns 400."""
        response = self.client.post(
            "/api/model-lab/presets",
            json={"capability": "text", "name": "Test", "values": "not a dict"},
        )
        self.assertEqual(response.status_code, 400)

    def test_put_update_preset(self) -> None:
        """PUT /api/model-lab/presets/{id} updates a preset."""
        create_response = self.client.post(
            "/api/model-lab/presets",
            json={"capability": "text", "name": "Original", "values": {"a": 1}},
        )
        preset_id = create_response.json()["id"]

        response = self.client.put(
            f"/api/model-lab/presets/{preset_id}",
            json={"name": "Updated", "values": {"a": 2}},
        )
        self.assertEqual(response.status_code, 200)
        preset = response.json()
        self.assertEqual(preset["name"], "Updated")
        self.assertEqual(preset["values"], {"a": 2})

    def test_put_update_builtin_preset(self) -> None:
        """PUT to a builtin preset returns 400."""
        response = self.client.put(
            "/api/model-lab/presets/builtin:text:default",
            json={"name": "Modified"},
        )
        self.assertEqual(response.status_code, 400)

    def test_put_update_unknown_preset(self) -> None:
        """PUT to a nonexistent preset returns 404."""
        response = self.client.put(
            "/api/model-lab/presets/p_nonexistent",
            json={"name": "Test"},
        )
        self.assertEqual(response.status_code, 404)

    def test_delete_preset(self) -> None:
        """DELETE /api/model-lab/presets/{id} deletes a preset."""
        create_response = self.client.post(
            "/api/model-lab/presets",
            json={"capability": "text", "name": "To Delete", "values": {}},
        )
        preset_id = create_response.json()["id"]

        response = self.client.delete(f"/api/model-lab/presets/{preset_id}")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data, {"ok": True})

        # Verify it's gone.
        list_response = self.client.get("/api/model-lab/presets?capability=text")
        presets = list_response.json()["presets"]
        ids = [p["id"] for p in presets]
        self.assertNotIn(preset_id, ids)

    def test_delete_builtin_preset(self) -> None:
        """DELETE of a builtin preset returns 400."""
        response = self.client.delete("/api/model-lab/presets/builtin:text:default")
        self.assertEqual(response.status_code, 400)

    def test_delete_unknown_preset(self) -> None:
        """DELETE of a nonexistent preset returns 404."""
        response = self.client.delete("/api/model-lab/presets/p_nonexistent")
        self.assertEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main()
