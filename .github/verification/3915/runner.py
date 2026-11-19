"""Hosted-only proposal. Never run this driver in the denied cloud runtime."""
import json
import hashlib
import re
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import wave
from classify import classify, pair
from overlay import install_overlays

PARENT = '1f460f495ac3013a96121f03176bd36d7219c0ff'
HEAD = 'cbf4b66f756a43c3e57a13362cf9a2061397ea17'
SOURCE = 'https://github.com/calebn/sharecut-studio.git'
HERE = Path(__file__).resolve().parent
CHECKOUTS = Path(tempfile.mkdtemp(prefix='sharecut-e2e-independent3915-'))
ENV = {k: os.environ[k] for k in ('PATH','HOME','TMPDIR','RUNNER_TEMP','PLAYWRIGHT_BROWSERS_PATH') if k in os.environ}
ENV.update(CI='1', GIT_TERMINAL_PROMPT='0', GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', UV_NO_PROGRESS='1', UV_PYTHON_DOWNLOADS='never')

def run(args, cwd, env=ENV, required=True):
    # Do not forward stdout/stderr, error text, HTTP payloads, traces, or environment.
    with (CHECKOUTS/'private.log').open('ab') as log:
        code = subprocess.run(args, cwd=cwd, env=env, stdout=log, stderr=log, timeout=1200).returncode
    if required and code: raise RuntimeError('BLOCKED')
    return code

def output(args, cwd):
    return subprocess.check_output(args,cwd=cwd,env=ENV,stderr=subprocess.DEVNULL,text=True).strip()

def emit(n, status):
    assert n in {*range(1,9), *range(101,113), *range(201,213)}
    assert status in ('PASS','BLOCKED','EXPECTED_REGRESSION','BEHAVIOR_CONFIRMED')
    print(json.dumps({'ordinal':n,'status':status},separators=(',',':')),flush=True)

def identity(name, value):
    # Fixed identifiers and narrow lexical forms; never paths, image digests we did not resolve,
    # exception text, arbitrary JSON, OS/environment, or repository content.
    patterns = {
        "parent_source": r"[0-9a-f]{40}", "head_source": r"[0-9a-f]{40}",
        "npm_lock": r"[0-9a-f]{64}", "python_lock": r"[0-9a-f]{64}", "test": r"[0-9a-f]{64}",
        "python": r"[0-9]+\.[0-9]+\.[0-9]+", "node": r"v[0-9]+\.[0-9]+\.[0-9]+",
        "uv": r"0\.13\.9", "playwright": r"1\.65\.0",
        "parent_browser": r"[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+", "head_browser": r"[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+",
    }
    if name not in patterns or not re.fullmatch(patterns[name], value): raise RuntimeError("BLOCKED")
    print(json.dumps({"identity":name,"value":value},separators=(",",":")),flush=True)

def prepare():
    for name, sha in [('parent',PARENT),('head',HEAD)]:
        p=CHECKOUTS/name; p.mkdir()
        run(['git','init','-q'],p)
        run(['git','-c','core.hooksPath=/dev/null','fetch','--depth=1',SOURCE,sha],p)
        run(['git','-c','core.hooksPath=/dev/null','checkout','--detach','FETCH_HEAD'],p)
        if output(['git','rev-parse','HEAD'],p) != sha: raise RuntimeError('BLOCKED')
    lock=json.loads((CHECKOUTS/'head/gui/web/package-lock.json').read_text())
    if lock['packages']['node_modules/@playwright/test']['version'] != '1.65.0': raise RuntimeError('BLOCKED')
    for file in ['gui/web/package-lock.json','uv.lock','pyproject.toml']:
        if (CHECKOUTS/'parent'/file).read_bytes() != (CHECKOUTS/'head'/file).read_bytes(): raise RuntimeError('BLOCKED')
    identity("parent_source",PARENT); identity("head_source",HEAD)
    identity("npm_lock",hashlib.sha256((CHECKOUTS/'head/gui/web/package-lock.json').read_bytes()).hexdigest())
    identity("python_lock",hashlib.sha256((CHECKOUTS/'head/uv.lock').read_bytes()).hexdigest())
    identity("test",hashlib.sha256((HERE/'independent-3915.spec.ts').read_bytes()).hexdigest())
    identity("python",".".join(map(str,sys.version_info[:3])))
    identity("node",output(['node','--version'],CHECKOUTS)); identity("playwright",lock['packages']['node_modules/@playwright/test']['version'])
    emit(1,'PASS')
    try:
        install_overlays(CHECKOUTS,HERE)
    except Exception:
        emit(8,'BLOCKED')
        raise
    emit(8,'PASS')
    bootstrap=CHECKOUTS/'bootstrap'
    run([sys.executable,'-m','venv',str(bootstrap)],CHECKOUTS)
    run([str(bootstrap/'bin/python'),'-m','pip','install','--disable-pip-version-check','uv==0.13.9'],CHECKOUTS)
    uv=str(bootstrap/'bin/uv')
    identity('uv',output([str(bootstrap/'bin/python'),'-c',"from importlib.metadata import version; print(version('uv'))"],CHECKOUTS))
    for name in ['parent','head']:
        p=CHECKOUTS/name
        run([uv,'sync','--frozen','--extra','gui','--python',sys.executable],p)
        run(['npm','ci','--ignore-scripts','--no-audit','--no-fund'],p/'gui/web')
        run(['npm','run','build'],p/'gui/web')
    # Reviewed repository installer verifies the catalog archive and binaries.
    payload=CHECKOUTS/'ffmpeg'
    run([str(CHECKOUTS/'head/.venv/bin/python'),'scripts/ffmpeg_payload.py','--output',str(payload)],CHECKOUTS/'head')
    emit(2,'PASS')
    return payload

def exercise(name,payload):
    p=CHECKOUTS/name; web=p/'gui/web'
    fixture=CHECKOUTS/('sharecut-e2e-'+name); fixture.mkdir(); (fixture/'raw').mkdir()
    doc=json.loads((p/'gui/web/e2e/fixtures/script-recording-identity.sharecut').read_text())
    doc['meta']['workspace_dir']=str(fixture)
    (fixture/'episode.sharecut').write_text(json.dumps(doc))
    for wav in ('primary','other'):
        with wave.open(str(fixture/'raw'/f'{wav}.wav'),'wb') as f:
            f.setparams((1,2,48000,0,'NONE','not compressed')); f.writeframes(bytes(48000*10*2))
    env={**ENV,'PATH':str(p/'.venv/bin')+':'+str(payload/'bin')+':'+ENV['PATH'], 'PYTHONPATH':str(p/'src'),'PODCAST_GUI_DIST':str(web/'dist'),'DAW_E2E_PROJECT':str(fixture/'episode.sharecut'),'PODCAST_MCP_FFMPEG':str(payload/'bin/ffmpeg'),'PODCAST_MCP_FFPROBE':str(payload/'bin/ffprobe')}
    for key,file in [('V3915_RECORDS','records.json'),('V3915_RESULT','result.json'),('V3915_CLEANUP','cleanup.txt'),('V3915_BROWSER','browser.txt')]: env[key]=str(fixture/file)
    code=run(['node','node_modules/vite-node/dist/cli.mjs','scripts/independent3915-run.ts'],web,env,False)
    try:
        records=json.loads((fixture/'records.json').read_text())
        result=json.loads((fixture/'result.json').read_text())
        cleanup=(fixture/'cleanup.txt').read_text()
    except (OSError,ValueError): return 'BLOCKED'
    verdict=classify(records,result,code,cleanup)
    if verdict != "BLOCKED":
        identity(name+"_browser",(fixture/"browser.txt").read_text())
        for record in records:
            emit((100 if name == "parent" else 200)+record["ordinal"], "PASS" if record["status"] == "PASS" else "EXPECTED_REGRESSION")
    return verdict

def main():
    final='BLOCKED'
    try:
        payload=prepare()
        parent=exercise('parent',payload); emit(3,parent if parent=='EXPECTED_REGRESSION' else 'BLOCKED')
        head=exercise('head',payload); emit(4,head if head=='PASS' else 'BLOCKED')
        final=pair(parent,head); emit(5,final)
    except Exception:
        emit(5,'BLOCKED')
    finally:
        try: shutil.rmtree(CHECKOUTS); emit(6,'PASS')
        except Exception: final='BLOCKED'; emit(6,'BLOCKED')
    emit(7,final)
    return 0 if final=='BEHAVIOR_CONFIRMED' else 1

if __name__=='__main__': sys.exit(main())
