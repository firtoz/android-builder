"""One-shot build identity, bounded observation and durable stage receipts.

No cloud credentials or signing keys are passed to this process. Running a build
claim twice is forbidden, including after a crash with uncertain completion.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import time

ROOT = Path(__file__).resolve().parent


def save(name, value):
    temporary = ROOT / (name + '.next')
    with temporary.open('w') as f:
        json.dump(value, f)
        f.flush()
        os.fsync(f.fileno())
    temporary.replace(ROOT / name)
    fd = os.open(ROOT, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def extract(archive, destination):
    destination.mkdir(exist_ok=True)
    with tarfile.open(archive) as source:
        seen = set()
        for member in source.getmembers():
            path = Path(member.name)
            if path.is_absolute() or '..' in path.parts or member.name in seen:
                raise ValueError('Unsafe or duplicate archive entry')
            seen.add(member.name)
            if not member.isdir() and not member.isfile():
                raise ValueError('Links and special files are not build inputs')
        source.extractall(destination, filter='data')


def stage(name, command):
    start = time.monotonic()
    status = json.loads((ROOT / 'status.json').read_text())
    status.update(state='running', phase=name)
    save('status.json', status)
    with (ROOT / 'build.log').open('ab', buffering=0) as log:
        log.write(('\n--- ' + name + ' ---\n').encode())
        proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        truncated = False
        while True:
            data = proc.stdout.read(65536)
            if not data:
                break
            remaining = max(0, 32 * 1024 * 1024 - os.fstat(log.fileno()).st_size)
            log.write(data[:remaining])
            truncated = truncated or len(data) > remaining
        proc.stdout.close()
        result_code = proc.wait()
    status = json.loads((ROOT / 'status.json').read_text())
    status['logTruncated'] = status.get('logTruncated', False) or truncated
    status['timings'].append(dict(phase=name, seconds=time.monotonic() - start, exitCode=result_code))
    save('status.json', status)
    return result_code


def verify():
    inputs = json.loads((ROOT / 'inputs.json').read_text())
    for item in inputs:
        data = (ROOT / item['name']).read_bytes()
        if len(data) != item['bytes'] or hashlib.sha256(data).hexdigest() != item['sha256']:
            raise ValueError('Uploaded build input mismatch')
    extract(ROOT / 'source.tgz', ROOT / 'src')
    extract(ROOT / 'licenses.tgz', ROOT / 'sdk')
    expected = json.loads((ROOT / 'source-manifest.json').read_text())
    actual = {str(p.relative_to(ROOT / 'src')) for p in (ROOT / 'src').rglob('*') if p.is_file()}
    if actual != {item['path'] for item in expected}:
        raise ValueError('Source entries differ from frozen manifest')
    for item in expected:
        p = ROOT / 'src' / item['path']
        if hashlib.sha256(p.read_bytes()).hexdigest() != item['sha256'] or p.stat().st_size != item['bytes']:
            raise ValueError('Source bytes differ from frozen manifest')
        p.chmod(item['mode'])
    config = json.loads((ROOT / 'config.json').read_text())
    for item in config.get('publicInputs', []):
        target = ROOT / 'src' / item['target']
        if not target.resolve().is_relative_to((ROOT / 'src').resolve()) or target.exists():
            raise ValueError('Public input target is unsafe or overlaps source')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((ROOT / item['name']).read_bytes())

def run():
    status = dict(state='running', phase='verify', timings=[])
    save('status.json', status)
    code = 125
    try:
        verify()
        code = stage('build', ['bash', str(ROOT / 'build.sh')])
        status = json.loads((ROOT / 'status.json').read_text())
        if code == 0:
            apk = ROOT / 'artifact.apk'
            data = apk.read_bytes()
            status['artifact'] = dict(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
    except Exception:
        code = 125
        # Detailed compiler output is in build.log. Never serialize environment.
        status = json.loads((ROOT / 'status.json').read_text())
        status['phase'] = 'failed-input-or-build'
    status.update(state='complete' if code == 0 else 'failed', exitCode=code)
    save('status.json', status)


mode = sys.argv[1]
if mode == 'launch':
    try:
        with (ROOT / 'launch.claim').open('x') as f:
            f.write(str(time.time()))
            f.flush()
            os.fsync(f.fileno())
    except FileExistsError:
        print(json.dumps({'existing': True}))
    else:
        fd = os.open(ROOT, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        # Persist the claim BEFORE starting. An interrupted gap fails closed;
        # the controller observes the claim and never starts a second build.
        with (ROOT / 'launcher.log').open('ab') as log:
            config = json.loads((ROOT / 'config.json').read_text())
            proc = subprocess.Popen(['timeout', '--kill-after=20s', str(config['executionSeconds']), sys.executable, str(ROOT / 'host.py'), 'run'], stdout=log, stderr=log, start_new_session=True)
        save('process.json', {'pid': proc.pid})
        print(json.dumps({'started': True}))
elif mode == 'verify':
    verify()
    print(json.dumps({'verified': True}))
elif mode == 'run':
    run()
elif mode == 'stage':
    sys.exit(stage(sys.argv[2], sys.argv[3:]))
elif mode == 'observe':
    offset = int(sys.argv[2])
    if offset < 0 or offset > 32 * 1024 * 1024:
        raise ValueError('Log cursor out of bounds')
    data = b''
    if (ROOT / 'build.log').exists():
        with (ROOT / 'build.log').open('rb') as f:
            f.seek(offset)
            data = f.read(65536)
    status = json.loads((ROOT / 'status.json').read_text()) if (ROOT / 'status.json').exists() else None
    print(json.dumps({'cursor': offset + len(data), 'log': base64.b64encode(data).decode(), 'status': status, 'claimed': (ROOT / 'launch.claim').exists()}))
else:
    raise ValueError('Unsupported host command')
