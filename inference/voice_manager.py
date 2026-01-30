import argparse
import json
import os
import shutil
from datetime import datetime


def voices_dir() -> str:
    return os.path.join(os.path.dirname(__file__), "voices")


def ensure_voices_dir() -> None:
    os.makedirs(voices_dir(), exist_ok=True)


def voice_path(name: str) -> str:
    return os.path.join(voices_dir(), name)


def metadata_path(name: str) -> str:
    return os.path.join(voice_path(name), "voice.json")


def load_metadata(name: str) -> dict:
    path = metadata_path(name)
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def write_metadata(name: str, source: str, description: str | None) -> None:
    data = {
        "name": name,
        "source": source,
        "description": description or "",
        "created_at": datetime.utcnow().isoformat() + "Z",
    }
    with open(metadata_path(name), "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=True, indent=2)


def list_voices() -> None:
    ensure_voices_dir()
    names = sorted(
        name
        for name in os.listdir(voices_dir())
        if os.path.isdir(voice_path(name))
    )
    if not names:
        print("No voices found")
        return
    for name in names:
        metadata = load_metadata(name)
        description = metadata.get("description", "")
        if description:
            print(f"{name} - {description}")
        else:
            print(name)


def clone_voice(name: str, source: str, description: str | None) -> None:
    ensure_voices_dir()
    dest = voice_path(name)
    if os.path.exists(dest):
        raise FileExistsError(f"Voice already exists: {name}")

    if os.path.isdir(source):
        shutil.copytree(source, dest)
    elif os.path.isfile(source):
        os.makedirs(dest, exist_ok=False)
        shutil.copy2(source, os.path.join(dest, os.path.basename(source)))
    else:
        raise FileNotFoundError(f"Source not found: {source}")

    write_metadata(name, source, description)
    print(f"Cloned voice: {name}")


def delete_voice(name: str) -> None:
    dest = voice_path(name)
    if not os.path.exists(dest):
        raise FileNotFoundError(f"Voice not found: {name}")
    shutil.rmtree(dest)
    print(f"Deleted voice: {name}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Voice reference manager")
    subparsers = parser.add_subparsers(dest="command", required=True)

    list_parser = subparsers.add_parser("list", help="List available voices")
    list_parser.set_defaults(func=lambda _: list_voices())

    clone_parser = subparsers.add_parser("clone", help="Clone a voice reference")
    clone_parser.add_argument("--name", required=True, help="Voice name")
    clone_parser.add_argument("--source", required=True, help="Source file or directory")
    clone_parser.add_argument("--description", help="Optional description")
    clone_parser.set_defaults(
        func=lambda args: clone_voice(args.name, args.source, args.description)
    )

    delete_parser = subparsers.add_parser("delete", help="Delete a voice reference")
    delete_parser.add_argument("--name", required=True, help="Voice name")
    delete_parser.set_defaults(func=lambda args: delete_voice(args.name))

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
