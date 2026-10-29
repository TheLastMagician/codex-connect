import json
import argparse
from pathlib import Path
from urllib.request import urlopen
import zipfile
import jsonschema

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description='Validate and package Codex Connect')
parser.add_argument('--output', type=Path, help='Override the output ZIP path')
args = parser.parse_args()
for filename in ('plugin.json', 'mcp.json'):
    document = json.loads((root / filename).read_text(encoding='utf-8'))
    with urlopen(document['$schema'], timeout=20) as response:
        schema = json.load(response)
    jsonschema.Draft202012Validator(schema).validate(document)

manifest = json.loads((root/'plugin.json').read_text(encoding='utf-8'))
assert len(manifest['extensions']['com.openai']['interface']['shortDescription']) <= 30
legacy = json.loads((root/'.codex-plugin/plugin.json').read_text(encoding='utf-8'))
assert (manifest['name'], manifest['version']) == (legacy['name'], legacy['version'])
files = [root/name for name in ('plugin.json','mcp.json','.mcp.json','README.md','LICENSE','CHANGELOG.md','setup.cmd','package.json','package-lock.json')]
for directory in ('.codex-plugin','assets','skills','src','scripts','dist','tests','web','tools','docs'):
    files.extend(path for path in (root/directory).rglob('*') if path.is_file())
config = Path.home()/'.codex-feishu-desktop/config.json'
secret = json.loads(config.read_text(encoding='utf-8')).get('appSecret','') if config.exists() else ''
wechat_config = Path.home()/'.codex-feishu-desktop/wechat.json'
wechat_secret = json.loads(wechat_config.read_text(encoding='utf-8')).get('token','') if wechat_config.exists() else ''
assistant_config = Path.home()/'.codex-feishu-desktop/assistant.json'
assistant_secret = json.loads(assistant_config.read_text(encoding='utf-8')).get('apiKey','') if assistant_config.exists() else ''
bots_config = Path.home()/'.codex-feishu-desktop/feishu-bots.json'
bot_secrets = [bot.get('appSecret','') for bot in json.loads(bots_config.read_text(encoding='utf-8')).get('bots',[])] if bots_config.exists() else []
archive = args.output or root/'releases'/f"{manifest['name']}-{manifest['version']}.zip"
archive.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as zipped:
    for file in files:
        assert not file.is_symlink()
        relative=file.relative_to(root)
        assert '..' not in relative.parts
        data=file.read_bytes()
        assert not secret or secret.encode() not in data, 'Credentials present in package'
        assert not wechat_secret or wechat_secret.encode() not in data, 'WeChat credentials present in package'
        assert not assistant_secret or assistant_secret.encode() not in data, 'Assistant credentials present in package'
        assert all(not value or value.encode() not in data for value in bot_secrets), 'Bot credentials present in package'
        zipped.writestr(str(Path(manifest['name'])/relative).replace('\\','/'),data)
with zipfile.ZipFile(archive) as zipped:
    assert zipped.testzip() is None
    assert all(name.startswith(manifest['name'] + '/') for name in zipped.namelist())
    print(json.dumps({'archive':str(archive),'files':len(zipped.namelist()),'bytes':archive.stat().st_size,'schemas':'valid','credentials':'excluded'}))
