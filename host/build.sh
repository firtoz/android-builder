#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
export ANDROID_BUILDER_ROOT="$PWD"
export CI=1 EXPO_NO_TELEMETRY=1
stage() { python3 "$ANDROID_BUILDER_ROOT/host.py" stage "$@"; }
python3 - <<'PY'
import json,pathlib,shlex
v=json.loads(pathlib.Path('config.json').read_text());t=v['toolchain']
values=dict(v['publicEnvironment'])
values.update(NODE_VERSION=t['node'],JAVA_MAJOR=str(t['javaMajor']),ANDROID_VERSION=str(t['sdk']),BUILD_TOOLS=t['buildTools'],ANDROID_TOOLS_ARCHIVE=t['toolsArchive'],ANDROID_TOOLS_SHA256=t['toolsSha256'])
pathlib.Path('public-env.sh').write_text('\n'.join('export '+k+'='+shlex.quote(x) for k,x in values.items())+'\n')
PY
source ./public-env.sh
stage system-update sudo -n apt-get update -qq
stage system-tools sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "openjdk-${JAVA_MAJOR}-jdk-headless" curl ca-certificates unzip git zip xz-utils build-essential python3
mkdir -p tools sdk/cmdline-tools
curl -fsSL --max-time 180 "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o tools/node.tar.xz
curl -fsSL --max-time 60 "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o tools/node.SHA256SUMS
(cd tools; grep " node-v${NODE_VERSION}-linux-x64.tar.xz$" node.SHA256SUMS | sed "s/node-v${NODE_VERSION}-linux-x64.tar.xz/node.tar.xz/" | sha256sum -c -; tar -xf node.tar.xz)
export PATH="$PWD/tools/node-v${NODE_VERSION}-linux-x64/bin:$PATH"
export JAVA_HOME=/usr/lib/jvm/java-${JAVA_MAJOR}-openjdk-amd64
export ANDROID_HOME="$PWD/sdk" ANDROID_SDK_ROOT="$PWD/sdk"
curl -fsSL --max-time 240 "https://dl.google.com/android/repository/${ANDROID_TOOLS_ARCHIVE}" -o tools/android-tools.zip
printf '%s  %s\n' "$ANDROID_TOOLS_SHA256" tools/android-tools.zip | sha256sum -c -
unzip -q tools/android-tools.zip -d tools/android-unpack
mv tools/android-unpack/cmdline-tools sdk/cmdline-tools/latest
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
# Only previously accepted license hashes are supplied. Never accept terms here.
python3 - <<'PY'
import json,os,subprocess,pathlib
v=json.loads(pathlib.Path('config.json').read_text());t=v['toolchain']
args=['sdkmanager','--sdk_root='+os.environ['ANDROID_HOME'],'platform-tools','platforms;android-'+str(t['sdk']),'build-tools;'+t['buildTools']]
for k in ['ndk','cmake']:
 if k in t:args.append(k+';'+t[k])
subprocess.run(['python3','host.py','stage','android-sdk',*args],stdin=subprocess.DEVNULL,check=True)
PY
export GRADLE_USER_HOME="$PWD/gradle-home"
python3 - <<'PY'
import json,os,pathlib,shutil,subprocess
root=pathlib.Path(os.environ['ANDROID_BUILDER_ROOT']);v=json.loads((root/'config.json').read_text());src=root/'src'
def stage(name,args,cwd):subprocess.run(['python3',str(root/'host.py'),'stage',name,*args],cwd=cwd,check=True)
pm=v.get('packageManager')
if pm:
 kind=pm['kind'];version=pm['version']
 if kind=='bun':
  stage('package-manager',['npm','install','--prefix',str(root/'tools'),'--ignore-scripts','--no-audit','--no-fund','@oven/bun-linux-x64@'+version],root)
  binary=str(root/'tools/node_modules/@oven/bun-linux-x64/bin/bun');install=[binary,'install','--frozen-lockfile']
 elif kind=='pnpm':
  stage('package-manager',['npm','install','--prefix',str(root/'tools'),'--ignore-scripts','--no-audit','--no-fund','pnpm@'+version],root)
  binary=str(root/'tools/node_modules/.bin/pnpm');install=[binary,'install','--frozen-lockfile']
 else:
  stage('package-manager',['npm','install','--prefix',str(root/'tools'),'--ignore-scripts','--no-audit','--no-fund','npm@'+version],root)
  binary=str(root/'tools/node_modules/.bin/npm');install=[binary,'ci','--no-audit','--no-fund']
 os.environ['PATH']=str(pathlib.Path(binary).parent)+os.pathsep+os.environ['PATH']
 stage('dependencies',install,src)
project=src/v['project']['directory']
if v['project']['kind']=='expo':
 exe=project/'node_modules/.bin/expo'
 if not exe.exists():exe=src/'node_modules/.bin/expo'
 stage('prebuild',[str(exe),'prebuild','--platform','android','--no-install'],project)
 project=project/'android'
os.environ['GRADLE_OPTS']='-Dorg.gradle.jvmargs="-Xmx'+str(v['gradle']['heapMb'])+'m -XX:MaxMetaspaceSize=768m -Dfile.encoding=UTF-8" -Dorg.gradle.daemon=false'
stage('gradle',['./gradlew',*v['gradle']['tasks'],*v['gradle']['arguments']],project)
artifact=(src/v['artifact']).resolve()
if not artifact.is_relative_to(src.resolve()) or not artifact.is_file() or artifact.is_symlink():raise ValueError('Artifact escapes source or is missing')
if artifact.stat().st_size<=0 or artifact.stat().st_size>1024*1024*1024:raise ValueError('Artifact size out of bounds')
shutil.copyfile(artifact,root/'artifact.apk')
tools=root/'sdk/build-tools'/v['toolchain']['buildTools']
stage('signature',[str(tools/'apksigner'),'verify',str(root/'artifact.apk')],root)
text=subprocess.check_output([str(tools/'aapt'),'dump','badging',str(root/'artifact.apk')],text=True)
if not text.startswith("package: name='"+v['applicationId']+"'"):raise ValueError('Wrong APK package')
if v.get('abis'):
 import re
 line=next(x for x in text.splitlines() if x.startswith('native-code:'))
 if set(re.findall("'([^']+)'",line))!=set(v['abis']):raise ValueError('Wrong ABI set')
PY
