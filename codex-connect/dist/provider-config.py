"""Read provider endpoints and patch exactly one base_url without rewriting TOML."""
import json
import os
from pathlib import Path
import sys
import tempfile
import tomllib


def table_path(header):
    try:
        value = tomllib.loads(header + '\n__codex_connect_marker = true\n')
        keys = []
        while isinstance(value, dict) and '__codex_connect_marker' not in value:
            if len(value) != 1:
                return None
            key, value = next(iter(value.items()))
            keys.append(key)
        return keys
    except tomllib.TOMLDecodeError:
        return None


def update_url(raw, provider_id, expected, replacement):
    parsed = tomllib.loads(raw)
    if parsed.get('model_providers', {}).get(provider_id, {}).get('base_url') != expected:
        raise ValueError('供应商地址已被其他操作修改，未覆盖配置。')
    lines = raw.splitlines(keepends=True)
    current = None
    matches = []
    for index, line in enumerate(lines):
        if line.lstrip().startswith('['):
            current = table_path(line.strip())
        elif current == ['model_providers', provider_id]:
            try:
                item = tomllib.loads(line)
            except tomllib.TOMLDecodeError:
                continue
            if 'base_url' in item and item['base_url'] == expected:
                matches.append(index)
    if len(matches) != 1:
        raise ValueError('供应商 base_url 不是独立单行配置，未修改配置。')
    index = matches[0]
    line = lines[index]
    start = line.index('=') + 1
    while start < len(line) and line[start].isspace():
        start += 1
    quote = line[start]
    if quote not in ('"', "'") or line[start:start + 3] == quote * 3:
        raise ValueError('Unsupported URL literal')
    end = start + 1
    while end < len(line):
        if quote == '"' and line[end] == '\\':
            end += 2
        elif line[end] == quote:
            break
        else:
            end += 1
    lines[index] = line[:start] + json.dumps(replacement, ensure_ascii=False) + line[end + 1:]
    candidate = ''.join(lines)
    updated = tomllib.loads(candidate)
    updated['model_providers'][provider_id]['base_url'] = expected
    if updated != parsed:
        raise ValueError('供应商配置保留校验失败，未修改配置。')
    return candidate


def main():
    request = json.load(sys.stdin)
    config = (Path(request['codexHome']) / 'config.toml').resolve(strict=True)
    original = config.read_bytes()
    raw = original.decode('utf-8-sig')
    parsed = tomllib.loads(raw)
    if request['action'] == 'list':
        providers = []
        for key, provider in parsed.get('model_providers', {}).items():
            if isinstance(provider, dict) and isinstance(provider.get('base_url'), str):
                providers.append({'id': key, 'name': provider.get('name', key),
                                  'baseUrl': provider['base_url'], 'wireApi': provider.get('wire_api', 'responses'),
                                  'supportsWebsockets': provider.get('supports_websockets', False)})
        return {'activeProvider': parsed.get('model_provider', 'openai'), 'providers': providers}
    if request['action'] != 'update':
        raise ValueError('Unknown provider operation')
    candidate = update_url(raw, request['providerId'], request['expected'], request['replacement'])
    backup = Path(request['backupPath'])
    backup.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with backup.open('xb') as saved:
        saved.write(original)
    if config.read_bytes() != original:
        raise ValueError('Codex 配置已被其他操作修改，未覆盖配置。')
    descriptor, temp = tempfile.mkstemp(prefix='.config-codex-connect-', dir=config.parent)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write((b'\xef\xbb\xbf' if original.startswith(b'\xef\xbb\xbf') else b'') + candidate.encode('utf-8'))
        if config.read_bytes() != original:
            raise ValueError('Codex 配置已被其他操作修改，未覆盖配置。')
        os.replace(temp, config)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return {'updated': True, 'backupPath': str(backup)}


if __name__ == '__main__':
    try:
        print(json.dumps(main(), ensure_ascii=True))
    except Exception:
        # Never echo configuration text, provider credentials, or TOML errors.
        print(json.dumps({'error': '供应商配置无法安全更新，请检查 Python 3.11+、配置文件及地址是否已改变。'}))
        sys.exit(1)
