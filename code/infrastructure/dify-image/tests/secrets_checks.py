"""Native anonymous-auth controls, root exceptions and actual image-layer audit."""
import json
import subprocess
import sys

import fixture

PROTOCOLS = r"""
import json,os,pathlib,socket,subprocess
from common import CAPS_BROKER,env_for,identity,run
root_roles={'sandbox':False,'shell_broker':False}
for p in pathlib.Path('/proc').iterdir():
 try:
  fields=dict(l.split(':',1) for l in (p/'status').read_text().splitlines() if ':' in l)
  if int(fields['Uid'].split()[0])!=0:continue
  argv=(p/'cmdline').read_bytes().split(b'\0')
  role=('sandbox' if argv[0]==b'/opt/dify-sandbox/main' else
        'shell_broker' if len(argv)>1 and argv[1]==b'/opt/dify-image/runtime/shell_broker.py' else None)
  if not role:continue
  for f in (p/'task').glob('*/status'):
   s=dict(l.split(':',1) for l in f.read_text().splitlines() if ':' in l)
   assert all(int(s[k],16)==CAPS_BROKER for k in ('CapPrm','CapEff'))
   assert not s['Groups'].strip()
   assert all(int(s[k],16)==0 for k in ('CapInh','CapAmb'))
   assert s['NoNewPrivs'].strip()=='1' and s['Seccomp'].strip()=='2'
  root_roles[role]=True
 except (OSError,ValueError):pass
assert all(root_roles.values())
with socket.create_connection(('127.0.0.1',6379),timeout=3) as sock:
 sock.sendall(b'*1\r\n$4\r\nPING\r\n');assert sock.recv(256).startswith(b'-NOAUTH')
 sock.sendall(b'*2\r\n$4\r\nAUTH\r\n$12\r\ndifyai123456\r\n')
 assert sock.recv(256).startswith(b'-WRONGPASS')
assert run('redis',['redis-cli','--no-auth-warning','PING'],env=env_for('redis')).stdout.strip()=='PONG'
args=['psql','-h','127.0.0.1','-U','dify','-d','dify','-w','-Atc','SELECT 1']
r=subprocess.run(args,env={'PATH':'/usr/bin:/bin'},capture_output=True,text=True,
 preexec_fn=identity('dev'),timeout=5)
assert r.returncode!=0 and 'no password supplied' in r.stderr
r=subprocess.run(args,env={'PATH':'/usr/bin:/bin','PGPASSWORD':'difyai123456'},
 capture_output=True,text=True,preexec_fn=identity('dev'),timeout=5)
assert r.returncode!=0 and 'password authentication failed' in r.stderr
env=env_for('api');env['PGPASSWORD']=env['DB_PASSWORD']
assert run('api',args,env=env).stdout.strip()=='1'
sshd=subprocess.run(['/usr/sbin/sshd','-T','-f','/run/dify/sshd.conf'],
 capture_output=True,text=True,check=True)
settings=dict(l.split(' ',1) for l in sshd.stdout.splitlines())
for key,value in {'permitrootlogin':'no','passwordauthentication':'no',
 'kbdinteractiveauthentication':'no','authenticationmethods':'publickey',
 'strictmodes':'yes','allowusers':'dev'}.items():assert settings[key]==value
print('NATIVE_SECRET_BOUNDARIES_OK')
"""

NO_LEAK = r"""
import json,sys
from pathlib import Path
p=json.load(sys.stdin);keys=json.loads(Path('/data/state/keys.json').read_text())
for value in [*keys.values(),p['admin_password']]:
 assert value not in p['logs'] and value not in p['metadata']
assert '-----BEGIN OPENSSH PRIVATE KEY-----' not in p['logs']
print('NO_CREDENTIAL_LEAKS')
"""

LAYERS = r"""
import hashlib,io,json,re,sys,tarfile
from pathlib import Path
needles=[v.encode() for v in json.loads(Path('/data/state/keys.json').read_text()).values()]
private=re.compile(rb'-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----\r?\n'
 rb'[a-zA-Z0-9+/=]{32,}')
files=layers=total=0
expected=set();audited=set()
# Public crypto self-test vectors are not deployment credentials. All 12 hashes
# were independently matched to gnutls-3.8.9/lib/crypto-selftests-pk.c in
# https://www.gnupg.org/ftp/gcrypt/gnutls/v3.8/gnutls-3.8.9.tar.xz
# archive SHA256 69e113d802d1670c4d5ac1b99040b1f2d5c7c05daec5003813c049b5184820ed.
# Only this exact qualified ELF at these two paths is accepted; no directory,
# library-name glob, arbitrary PEM or changed binary receives an exemption.
public_library='4b14edde42e7cbeefd8a6d88d035e096f2e6412a535388bb1d073a1c196e2822'
public_paths={'usr/lib/x86_64-linux-gnu/libgnutls.so.30.40.3',
              'opt/job-root/usr/lib/x86_64-linux-gnu/libgnutls.so.30.40.3'}
# Independently downloaded public release sources, checked against upstream
# Dify's uv.lock (first three) or PyPI's release digest (jwcrypto):
# pycryptodome-3.23.0.tar.gz: 447700a657182d60338bab09fdb27518f8856aecd80ae4c6bdddb67ff5da44ef
# future-1.0.0.tar.gz: bd2968309307861edae1458a4f8a4f3598c03be43b97521076aebf5d94c07b05
# gevent-26.4.0.tar.gz: 288d03addfccf0d1c67268358b6759b04392bf3bc35d26f3d9a45c82899c292d
# jwcrypto-1.5.7.tar.gz: 70204d7cca406eda8c82352e3c41ba2d946610dafd19e54403f0a1f4f18633c6
# Every member below matches its complete public source bytes, including files
# inherited in deleted lower layers. This is not a package/directory exemption.
api='app/api/.venv/lib/python3.13/site-packages/'
public_artifacts={
 api+'Crypto/SelfTest/Cipher/test_pkcs1_15.py':
  '9f7ae293bbedfdaf32bd892c9b81679a1d0fe82a480624d77827d98f5602c906',
 api+'Crypto/SelfTest/PublicKey/test_import_DSA.py':
  'd9a5613097b67f8a4d22d08366ca7adc805dc1fc6a8f3042400e1ac6fa9685e8',
 api+'Crypto/SelfTest/PublicKey/test_import_ECC.py':
  'c41b3b050c5450bf06a8005806f5fe20488718eefce7a7c13799da3f8c4c3ddf',
 api+'Crypto/SelfTest/PublicKey/test_import_RSA.py':
  '9ee884deb5c9703349d7b660ed3ff806c93eff2c62850b9e46aa7500a2697e08',
 api+'future/backports/test/badcert.pem':
  '262a107916641c7f211ac5898c0177535cd0bdc5aa872cc6e883842694d8f521',
 api+'future/backports/test/keycert.pem':
  'c4f5e2e6274f71055bae183106a1764cd1a6eac499d9a2d5544b7a0d6ce994bf',
 api+'future/backports/test/keycert2.pem':
  '0c1e3a144018bfc056c1027ee51cc2ebde85c4f37b08e37e42c8be478a682607',
 api+'future/backports/test/ssl_key.pem':
  '54a194f91dd461a6695535e5edc856978bc46040dea1bebd49fbd14d0f1aabfe',
 api+'gevent/tests/2_7_keycert.pem':
  '3ee48edaa0a681ae1a9fba644acedea75168d7acab40a77d8bce039eba9261c2',
 api+'gevent/tests/badcert.pem':
  '262a107916641c7f211ac5898c0177535cd0bdc5aa872cc6e883842694d8f521',
 api+'gevent/tests/keycert.pem':
  'af4284d561fd795e97e26532929098e439bcfeba1b0528b8cf031c1813ed322e',
 api+'gevent/tests/server.key':
  '09723c6e8f24bd3a3723fa349153da6ee434a0706ca0d6e01554f56d6353c0e2',
 api+'gevent/tests/test_server.key':
  'e72538418ef98155b04ede1313910a9223a110d1303b478ff681b759307476d9',
 api+'gevent/tests/wrongcert.pem':
  'ea7e2eef071a94d282b6732cabb27763bb8e89ecfdd3564b887dfca04d231943',
 api+'jwcrypto/tests.py':
  '16e5940e37d58ba3b976846f1af342f8fb394a07efa654fe084c97e3fff02f06',
 'opt/agent/.venv/lib/python3.13/site-packages/jwcrypto/tests.py':
  '16e5940e37d58ba3b976846f1af342f8fb394a07efa654fe084c97e3fff02f06',
 # Matched independently against the already pinned Dify 8e689e868b63 source.
 'app/api/tests/unit_tests/services/test_knowledge_fs_capability.py':
  'c445c464b73d1630abcb875338f5aef5d1696a95dbeff610a387810a49c1000b',
}
public_artifacts.update({path:public_library for path in public_paths})
def layer_member(name,head):
 # Docker's real 1024-byte empty tar has no ustar header. Two logical layers in
 # this image reference that same immutable 5f70bf18... blob; audit it too.
 return (name.endswith('/layer.tar') or head[257:262]==b'ustar'
         or head[:2]==b'\x1f\x8b' or head==bytes(512))
def coverage(expected,audited):
 assert expected and expected==audited,'Not every declared image layer was audited'
def scan(stream,name):
 global files,total
 files+=1;tail=b''
 qualified=public_artifacts.get(name.split(':',1)[-1])
 if qualified:
  material=stream.read(8*1024*1024+1);total+=len(material)
  assert hashlib.sha256(material).hexdigest()==qualified,'Public self-test artifact changed: '+name
  assert not any(key in material for key in needles),'Runtime credential in public artifact'
  return
 while True:
  block=stream.read(1024*1024)
  if not block:break
  total+=len(block);data=tail+block
  if any(k in data for k in needles) or private.search(data):
   for key in needles:name=name.replace(key.decode(),'[REDACTED]')
   raise RuntimeError('Credential-bearing image member: '+name)
  tail=data[-16384:]
with tarfile.open(fileobj=sys.stdin.buffer,mode='r|') as image:
 for member in image:
  if not member.isfile():continue
  stream=image.extractfile(member)
  head=stream.peek(512)[:512]
  if layer_member(member.name,head):
   layers+=1
   audited.add(member.name)
   with tarfile.open(fileobj=stream,mode='r|*') as layer:
    for entry in layer:
     if entry.isfile():scan(layer.extractfile(entry),member.name+':'+entry.name)
  elif head[:1] in (b'{',b'[') and member.size<8*1024*1024:
   data=stream.read();metadata=json.loads(data)
   if member.name=='manifest.json':
    expected.update(name for image in metadata for name in image['Layers'])
   elif isinstance(metadata,dict):
    expected.update('blobs/'+layer['digest'].replace(':','/') for layer in metadata.get('layers',[])
                    if 'image.layer.' in layer.get('mediaType','') or 'image.rootfs.diff.' in layer.get('mediaType',''))
   scan(io.BytesIO(data),member.name)
  else:scan(stream,member.name)
coverage(expected,audited)
assert layers>=1 and files>1000 and total>1024*1024*1024
print(json.dumps({'layers':layers,'files':files,'bytes':total,'verdict':'NO_EMBEDDED_CREDENTIALS'}))
"""


def verify(state, require):
    """Audit the final image, including deleted lower layers, without saving a tar."""
    print("security: native root/auth/sshd controls", file=sys.stderr, flush=True)
    require(fixture.execute(state, PROTOCOLS).stdout.strip() == "NATIVE_SECRET_BOUNDARIES_OK",
            "Root capability, anonymous DB/Redis or effective sshd policy failure")
    controls = LAYERS.split("with tarfile.open(fileobj=sys.stdin.buffer", 1)[0] + r"""
import os,subprocess
empty=bytes(1024)
assert hashlib.sha256(empty).hexdigest()=='5f70bf18a086007016e948b04aed3b82103a36bea41755b6cddfaf10ace3c6ef'
assert layer_member('blobs/sha256/empty',empty[:512])
assert not layer_member('blobs/sha256/config',b'{"schemaVersion":2}')
with tarfile.open(fileobj=io.BytesIO(empty),mode='r|*') as tar:assert list(tar)==[]
coverage({'regular','empty'},{'regular','empty'})
for observed in ({'regular'},{'regular','empty','unreferenced'}):
 try:coverage({'regular','empty'},observed)
 except AssertionError:pass
 else:raise AssertionError('Image scanner accepted incomplete/extra layer coverage')
library=Path('/usr/lib/x86_64-linux-gnu/libgnutls.so.30.40.3').read_bytes()
name='usr/lib/x86_64-linux-gnu/libgnutls.so.30.40.3'
scan(io.BytesIO(library),name)
source=api+'Crypto/SelfTest/Cipher/test_pkcs1_15.py'
os.seteuid(1101)
try:fixture=Path('/'+source).read_bytes()
finally:os.seteuid(0)
scan(io.BytesIO(fixture),source)
secret=Path('/data/ssh/ssh_host_ed25519_key').read_bytes()
short_secret=subprocess.check_output(['openssl','genpkey','-algorithm','ED25519'],
                                     stderr=subprocess.DEVNULL,timeout=10)
for content,path in ((library+b'changed',name),(library,'unqualified.so'),
                     (secret,'ssh/ssh_host_ed25519_key'),(library+secret,name),
                     (short_secret,'fresh-pkcs8-key'),(needles[0],'runtime-env'),
                     (fixture+b'changed',source),(fixture,'unqualified.py'),
                     *((short_secret,path) for path in public_artifacts)):
 try:scan(io.BytesIO(content),path)
 except (AssertionError,RuntimeError):pass
 else:raise AssertionError('Image scanner accepted a forbidden mutation')
print('IMAGE_SCANNER_CONTROLS_OK')
"""
    require(fixture.execute(state, controls).stdout.strip() == "IMAGE_SCANNER_CONTROLS_OK",
            "Image scanner public-vector/unknown-key/modified-library controls failed")
    logs = fixture.docker(["logs", state["container"]])
    metadata = fixture.docker(["image", "inspect", state["image"]]).stdout
    require(fixture.execute(state, NO_LEAK, data=json.dumps({
        "logs": logs.stdout + logs.stderr, "metadata": metadata,
        "admin_password": state["admin_password"]})).stdout.strip() == "NO_CREDENTIAL_LEAKS",
        "Runtime or image-metadata credential leakage")
    # Docker's classic exporter may stage its uncompressed archive internally.
    # Reserve that known peak in addition to the non-negotiable 3GiB floor.
    size = json.loads(metadata)[0]["Size"]
    require(min(fixture.guard.capacity().values()) >= size + 3 * 1024**3,
            "Insufficient measured headroom for actual image-layer export")
    exporter = subprocess.Popen(["docker", "image", "save", state["image"]],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    scanner = None
    try:
        print("security: scanning actual image layers", file=sys.stderr, flush=True)
        scanner = subprocess.Popen(
            ["docker", "exec", "-i", state["container"], "/usr/local/bin/python3", "-c", LAYERS],
            stdin=exporter.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        exporter.stdout.close()
        stdout, error = scanner.communicate(timeout=300)
        if scanner.returncode:
            summary = error.splitlines()[-1] if error.splitlines() else ""
            if summary.startswith(("RuntimeError: Credential-bearing image member: ",
                                   "AssertionError: ")):
                print(summary[:350], file=sys.stderr, flush=True)
            else:
                print(json.dumps({"imageScannerFailure": summary.split(":", 1)[0]}),
                      file=sys.stderr, flush=True)
        require(scanner.returncode == 0, "Actual image-layer credential scan failed")
        require(exporter.wait(timeout=20) == 0, "Image-layer export did not complete")
        evidence = json.loads(stdout)
        require(evidence["verdict"] == "NO_EMBEDDED_CREDENTIALS", "Layer audit verdict absent")
        print(json.dumps({"imageAudit": evidence}), file=sys.stderr, flush=True)
    finally:
        for process in (scanner, exporter):
            if process and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
