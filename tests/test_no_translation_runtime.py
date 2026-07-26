from pathlib import Path

FORBIDDEN_RUNTIME_TERMS = (
    "build_translation_system_prompt",
    "TranslationDirectionStripper",
    "SOURCE_LANG",
    "TARGET_LANG",
    "translation_direction",
)


def test_runtime_contains_no_translation_business_symbols() -> None:
    roots = [Path("app"), Path("client/src")]
    text = "\n".join(
        path.read_text(errors="ignore")
        for root in roots
        for path in root.rglob("*")
        if path.is_file() and path.suffix in {".py", ".ts", ".tsx", ".json"}
    )
    for term in FORBIDDEN_RUNTIME_TERMS:
        assert term not in text
