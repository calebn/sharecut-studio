"""Bounded subprocess diagnostics and pinned-action Python environment validation."""
from pathlib import Path
import os
import re
import subprocess

class SetupBlocked(RuntimeError):
    pass

def checked_process(args, cwd, env, log, receipt, ordinal, timeout=1200, capture=False):
    # No arguments, return codes, output, exception messages, or paths enter receipt.
    try:
        result=subprocess.run(args,cwd=cwd,env=env,stdout=subprocess.PIPE if capture else log,stderr=log,timeout=timeout,text=capture)
    except subprocess.TimeoutExpired:
        receipt(ordinal,'BLOCKED','TIMEOUT'); raise SetupBlocked() from None
    except OSError:
        receipt(ordinal,'BLOCKED','SPAWN_FAILED'); raise SetupBlocked() from None
    if result.returncode:
        receipt(ordinal,'BLOCKED','EXIT_NONZERO'); raise SetupBlocked() from None
    receipt(ordinal,'PASS','NONE')
    return result.stdout if capture else 0

def python_library_directory(source, executable, base_prefix, version, owner=None):
    # setup-python's pinned find-python.ts exports installDir/lib on Linux.
    # Reconstruct ONLY that entry, never forward arbitrary inherited loader paths.
    owner=os.getuid() if owner is None else owner
    cache=Path(source.get('RUNNER_TOOL_CACHE',''))
    location=Path(source.get('pythonLocation',''))
    if not cache.is_absolute() or not location.is_absolute(): raise SetupBlocked()
    cache=cache.resolve(strict=True); location=location.resolve(strict=True)
    if str(cache) not in ('/opt/hostedtoolcache','/__t'): raise SetupBlocked()
    if not re.fullmatch(r'3\.12\.[0-9]+',version): raise SetupBlocked()
    if location != cache/'Python'/version/'x64': raise SetupBlocked()
    if Path(base_prefix).resolve(strict=True) != location: raise SetupBlocked()
    if not Path(executable).resolve(strict=True).is_relative_to(location/'bin'): raise SetupBlocked()
    lib=(location/'lib').resolve(strict=True)
    if lib != location/'lib' or not lib.is_dir(): raise SetupBlocked()
    for path in (cache,location,lib):
        if path.stat().st_uid not in (0,owner): raise SetupBlocked()
    return str(lib)
