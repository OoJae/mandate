"""Drive `dkg init` through a pty, answering prompts by matching the prompt text.
Writes the transcript incrementally so progress can be polled from another shell."""
import os, sys, pty, select, re, time

ANSI = re.compile(r'\x1b\[[0-9;]*[A-Za-z]')
def clean(t):
    return ANSI.sub('', t).replace('\r', '')

home, name, port = sys.argv[1], sys.argv[2], sys.argv[3]
env = dict(os.environ, DKG_HOME=home)
os.makedirs(home, exist_ok=True)
log = open('spikes/out/init-%s.log' % name, 'wb', buffering=0)

CLI = 'node_modules/@origintrail-official/dkg/dist/cli.js'
cmd = ['node', CLI, 'init', '--network', 'testnet', '--role', 'edge', '--store', 'oxigraph', '-y']

answers = [
    (r'Node name',                 name),
    (r'API port',                  port),
    (r'Enable auto-update',        'n'),
    (r'Enable API authentication', 'y'),
]

pid, fd = pty.fork()
if pid == 0:
    os.execvpe(cmd[0], cmd, env); os._exit(1)

buf = b''
deadline = time.time() + 900
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 1.0)
    if not r:
        continue
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    buf += chunk
    log.write(chunk)
    tail = clean(buf.decode('utf8', 'replace'))
    last = tail.split('\n')[-1]
    if re.search(r':\s*$', last):                 # a prompt is waiting
        reply = ''
        for pat, ans in answers:
            if re.search(pat, last):
                reply = ans
                break
        log.write(('  <<< %r\n' % reply).encode())
        os.write(fd, (reply + '\n').encode())
        buf = b''
try:
    os.waitpid(pid, 0)
except OSError:
    pass
log.write(b'\n=== DRIVER EXIT ===\n')
log.close()
