# Runs on the remote server (piped over SSH as `python3 -u - <action> ...`).
# Bridges the voice bot to a Claude Code session running inside tmux there:
# input is typed into the tmux pane, the answer is read from the session's
# transcript (~/.claude/projects/*/<sessionId>.jsonl).
#
#   list                      -> JSON list of tmux panes running Claude
#   send <target> <b64 text>  -> JSON lines: {"event": "tool"|"done"|"error"|"timeout", ...}
#   interrupt <target>        -> presses Escape in the pane
#   type <target> <b64 text>  -> types the text + Enter, prints {"event": "typed", "sessionId": ...}
#   watch                     -> runs until killed; prints {"event": "answer", ...} every time any
#                                Claude session on this server finishes a turn
import base64
import glob
import json
import os
import subprocess
import sys
import time

HOME = os.path.expanduser('~')
TURN_TIMEOUT_S = 30 * 60


def out(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def sh(args):
    return subprocess.run(args, capture_output=True, text=True).stdout


def children(pid):
    return [int(p) for p in sh(['pgrep', '-P', str(pid)]).split()]


def session_for_pid(pid):
    path = os.path.join(HOME, '.claude', 'sessions', f'{pid}.json')
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def claude_session_in_pane(pane_pid):
    """Walk the pane's process tree and return the first Claude session found."""
    todo = [int(pane_pid)]
    seen = set()
    while todo:
        pid = todo.pop(0)
        if pid in seen:
            continue
        seen.add(pid)
        info = session_for_pid(pid)
        if info and info.get('sessionId'):
            info['pid'] = pid
            return info
        todo.extend(children(pid))
    return None


def panes():
    rows = []
    fmt = '#{session_name}:#{window_index}.#{pane_index}\t#{session_name}\t#{pane_pid}'
    for line in sh(['tmux', 'list-panes', '-a', '-F', fmt]).splitlines():
        target, name, pid = line.split('\t')
        info = claude_session_in_pane(pid)
        if info:
            rows.append({
                'target': target,
                'tmux': name,
                'sessionId': info['sessionId'],
                'name': info.get('name'),
                'cwd': info.get('cwd'),
            })
    return rows


def resolve(target):
    for row in panes():
        if target in (row['target'], row['tmux'], row['name'], row['sessionId']):
            return row
    return None


def transcript(session_id):
    matches = glob.glob(os.path.join(HOME, '.claude', 'projects', '*', f'{session_id}.jsonl'))
    return matches[0] if matches else None


def text_of(content):
    if isinstance(content, str):
        return content
    return '\n'.join(b.get('text', '') for b in content or [] if b.get('type') == 'text').strip()


def send(target, b64):
    text = base64.b64decode(b64).decode('utf-8').replace('\r', ' ').replace('\n', ' ').strip()
    row = resolve(target)
    if not row:
        out({'event': 'error', 'message': f'Tidak ada sesi Claude di tmux "{target}".'})
        return
    path = transcript(row['sessionId'])
    offset = os.path.getsize(path) if path else 0

    subprocess.run(['tmux', 'send-keys', '-t', row['target'], '-l', text])
    time.sleep(0.3)
    subprocess.run(['tmux', 'send-keys', '-t', row['target'], 'Enter'])

    started = time.time()
    seen_user = False
    last_text = ''
    buf = ''
    while time.time() - started < TURN_TIMEOUT_S:
        time.sleep(0.5)
        if not path:
            # A brand-new session may only create its transcript after the first prompt.
            row = resolve(target) or row
            path = transcript(row['sessionId'])
            offset = 0
            continue
        with open(path, encoding='utf-8') as f:
            f.seek(offset)
            chunk = f.read()
            offset = f.tell()
        buf += chunk
        *lines, buf = buf.split('\n')
        for line in lines:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get('isSidechain'):
                continue
            kind = d.get('type')
            msg = d.get('message') or {}
            if kind == 'user' and not d.get('isMeta'):
                content = msg.get('content')
                if isinstance(content, str) or any(b.get('type') == 'text' for b in content or []):
                    seen_user = True
            elif kind == 'assistant' and seen_user:
                for block in msg.get('content') or []:
                    if block.get('type') == 'tool_use':
                        out({'event': 'tool', 'name': block.get('name'), 'input': str(block.get('input'))[:160]})
                t = text_of(msg.get('content'))
                if t:
                    last_text = t
                if msg.get('stop_reason') == 'end_turn':
                    out({'event': 'done', 'text': last_text or 'Selesai.'})
                    return
            elif kind == 'system' and seen_user and d.get('subtype') == 'turn_duration':
                out({'event': 'done', 'text': last_text or 'Selesai.'})
                return
    out({'event': 'timeout', 'text': last_text})


def type_text(target, b64):
    text = base64.b64decode(b64).decode('utf-8').replace('\r', ' ').replace('\n', ' ').strip()
    row = resolve(target)
    if not row:
        out({'event': 'error', 'message': f'Tidak ada sesi Claude di tmux "{target}".'})
        return
    subprocess.run(['tmux', 'send-keys', '-t', row['target'], '-l', text])
    time.sleep(0.3)
    subprocess.run(['tmux', 'send-keys', '-t', row['target'], 'Enter'])
    out({'event': 'typed', 'sessionId': row['sessionId']})


def last_answer(path):
    try:
        size = os.path.getsize(path)
        with open(path, 'rb') as f:
            f.seek(max(0, size - 512 * 1024))
            lines = f.read().decode('utf-8', 'replace').split('\n')
        if size > 512 * 1024:
            lines = lines[1:]
    except OSError:
        return ''
    answer = ''
    for line in lines:
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if d.get('isSidechain'):
            continue
        msg = d.get('message') or {}
        content = msg.get('content')
        if d.get('type') == 'user' and not d.get('isMeta'):
            if isinstance(content, str) or any(b.get('type') == 'text' for b in content or []):
                answer = ''
        elif d.get('type') == 'assistant':
            t = text_of(content)
            if t:
                answer = t
    return answer


def watch():
    seen = {}
    spoken = {}
    first = True
    while True:
        for path in glob.glob(os.path.join(HOME, '.claude', 'sessions', '*.json')):
            try:
                with open(path) as f:
                    info = json.load(f)
            except (OSError, ValueError):
                continue
            sid = info.get('sessionId')
            if not sid:
                continue
            key = f"{info.get('status')}@{info.get('statusUpdatedAt', '')}"
            prev = seen.get(sid)
            seen[sid] = key
            if first or prev is None or prev == key or info.get('status') != 'idle':
                continue
            tpath = transcript(sid)
            text = last_answer(tpath) if tpath else ''
            if text and spoken.get(sid) != text:
                spoken[sid] = text
                tmux = next((r['tmux'] for r in panes() if r['sessionId'] == sid), None)
                out({'event': 'answer', 'sessionId': sid, 'name': info.get('name'), 'tmux': tmux, 'text': text})
        first = False
        time.sleep(1.5)


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else 'list'
    if action == 'list':
        out(panes())
    elif action == 'send':
        send(sys.argv[2], sys.argv[3])
    elif action == 'type':
        type_text(sys.argv[2], sys.argv[3])
    elif action == 'watch':
        watch()
    elif action == 'interrupt':
        row = resolve(sys.argv[2])
        if row:
            subprocess.run(['tmux', 'send-keys', '-t', row['target'], 'Escape'])
        out({'event': 'done', 'text': ''})


main()
