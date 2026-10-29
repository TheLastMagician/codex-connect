"""Read only the desktop's local chat metadata, including SQLite WAL updates."""
import json
import pathlib
import sqlite3
import sys


def catalog(home):
    home = pathlib.Path(home)
    database = home / 'state_5.sqlite'
    connection = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=3)
    try:
        connection.execute('PRAGMA query_only=ON')
        columns = {row[1] for row in connection.execute('PRAGMA table_info(threads)')}
        required = {'id', 'title', 'cwd', 'updated_at', 'archived'}
        if not required <= columns:
            raise ValueError('Unsupported desktop chat catalog schema')
        fields = ['id', 'title', 'cwd', 'updated_at']
        fields += [name for name in ['name', 'project_id', 'is_pinned', 'thread_source', 'source'] if name in columns]
        connection.row_factory = sqlite3.Row
        rows = [dict(row) for row in connection.execute(
            'SELECT ' + ','.join(fields) + ' FROM threads WHERE archived=0 ORDER BY updated_at DESC, id DESC')]
    finally:
        connection.close()
    names = {}
    index_path = home / 'session_index.jsonl'
    if index_path.exists():
        with index_path.open(encoding='utf-8') as index:
            for line in index:
                try:
                    entry = json.loads(line)
                    if entry.get('thread_name'):
                        names[entry['id']] = entry['thread_name']
                except (ValueError, KeyError):
                    continue
    for row in rows:
        row['title'] = row.get('name') or names.get(row['id']) or row['title']
    state_path = home / '.codex-global-state.json'
    state = json.loads(state_path.read_text(encoding='utf-8')) if state_path.exists() else {}
    keys = ['thread-project-assignments', 'thread-workspace-root-hints', 'projectless-thread-ids',
            'thread-project-membership-host-ids', 'app-server-project-id-by-legacy-project-id-by-host']
    return {'threads': rows, 'state': {key: state.get(key) for key in keys}}


if __name__ == '__main__':
    try:
        print(json.dumps(catalog(sys.argv[1]), ensure_ascii=True))
    except Exception:
        # Do not expose database paths, chat contents, or unrelated local state in errors.
        print('Local desktop chat catalog unavailable', file=sys.stderr)
        sys.exit(1)
