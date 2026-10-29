"""Package the portable plugin without dependencies, credentials, or local state."""
import json
import os
from pathlib import Path
import re
import tomllib
import zipfile

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / 'plugin.json').read_text(encoding='utf-8'))
interface = manifest['extensions']['com.openai']['interface']
assert manifest['name'] == root.name
assert re.fullmatch(r'\d+\.\d+\.\d+', manifest['version'])
assert len(interface['shortDescription']) <= 30
assert manifest['extensions']['com.openai']['requires_local_executor'] is True
legacy = json.loads((root / '.codex-plugin/plugin.json').read_text(encoding='utf-8'))
assert (legacy['name'], legacy['version']) == (manifest['name'], manifest['version'])
portable = json.loads((root / 'mcp.json').read_text(encoding='utf-8'))
assert portable['$schema'] == 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'
assert portable['mcpServers'][root.name]['type'] == 'stdio'
for key in ('logo', 'composerIcon'):
    asset = (root / interface[key]).resolve()
    assert asset.is_relative_to(root) and asset.is_file()

config_path = Path(os.environ.get('CODEX_HOME', Path.home() / '.codex')) / 'config.toml'
secrets = []
if config_path.is_file():
    config = tomllib.loads(config_path.read_text(encoding='utf-8-sig'))
    for provider in config.get('model_providers', {}).values():
        secrets.extend(filter(None, (provider.get('experimental_bearer_token'), os.environ.get(provider.get('env_key', '')))))
files = [root / name for name in ('plugin.json', 'mcp.json', '.mcp.json', 'README.md', 'LICENSE', 'package.json', 'package-lock.json')]
for directory in ('.codex-plugin', 'assets', 'skills', 'src', 'scripts', 'dist', 'tests', 'web'):
    files.extend(file for file in (root / directory).rglob('*') if file.is_file())
archive = root / 'releases' / f"{root.name}-{manifest['version']}.zip"
archive.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as zipped:
    for file in sorted(files):
        assert not file.is_symlink()
        relative = file.relative_to(root)
        assert '..' not in relative.parts
        assert not any(part in ('node_modules', '.git', '.work', '__pycache__') for part in relative.parts)
        data = file.read_bytes()
        assert all(secret.encode() not in data for secret in secrets), f'Credential found: {relative}'
        assert root.as_uri().encode() not in data, f'Build-machine path found: {relative}'
        zipped.writestr(f'{root.name}/{relative.as_posix()}', data)
with zipfile.ZipFile(archive) as zipped:
    assert zipped.testzip() is None
    assert all(name.startswith(root.name + '/') for name in zipped.namelist())
    print(json.dumps({'archive': str(archive), 'files': len(zipped.namelist()), 'bytes': archive.stat().st_size, 'credentials': 'excluded'}))
