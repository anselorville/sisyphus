import json
from pathlib import Path
manifest=json.loads(Path('../manifest.json').read_text())
print(f"Use {manifest['transport'].get('url')}")
