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

RUNTIME_ERRORS = frozenset({
    'CACHE_METADATA_MISSING','CACHE_RESOLVE_FAILED','CACHE_ROOT_UNRECOGNIZED',
    'LOCATION_METADATA_MISSING','LOCATION_RESOLVE_FAILED','VERSION_MISMATCH',
    'CACHE_LAYOUT_MISMATCH','PREFIX_MISMATCH','EXECUTABLE_MISMATCH',
    'ACTION_OUTPUT_MISSING','ACTION_OUTPUT_MISMATCH','LIBRARY_MISMATCH',
    'OWNER_MISMATCH','METADATA_IO_ERROR',
})

class RuntimePathBlocked(SetupBlocked):
    def __init__(self, code):
        assert code in RUNTIME_ERRORS
        self.code=code
        super().__init__(code)

def python_library_directory(source, executable, base_prefix, version, owner=None):
    # Match pinned setup-python.ts: nonempty AGENT_TOOLSDIRECTORY overrides cache
    # within the action process. That override need not be exported to later steps.
    owner=os.getuid() if owner is None else owner
    def require(ok, code):
        if not ok: raise RuntimePathBlocked(code)
    def resolved(raw, missing, failed):
        require(bool(raw) and Path(raw).is_absolute(),missing)
        try: return Path(raw).resolve(strict=True)
        except OSError: raise RuntimePathBlocked(failed) from None
    cache=resolved(source.get('AGENT_TOOLSDIRECTORY','').strip() or source.get('RUNNER_TOOL_CACHE',''), 'CACHE_METADATA_MISSING','CACHE_RESOLVE_FAILED')
    require(str(cache) in ('/opt/hostedtoolcache','/__t'),'CACHE_ROOT_UNRECOGNIZED')
    location=resolved(source.get('pythonLocation',''),'LOCATION_METADATA_MISSING','LOCATION_RESOLVE_FAILED')
    require(bool(re.fullmatch(r'3\.12\.[0-9]+',version)) and source.get('V3915_PYTHON_VERSION') == version,'VERSION_MISMATCH')
    require(location == cache/'Python'/version/'x64','CACHE_LAYOUT_MISMATCH')
    action_exe=resolved(source.get('V3915_PYTHON_PATH',''),'ACTION_OUTPUT_MISSING','ACTION_OUTPUT_MISMATCH')
    try:
        require(Path(base_prefix).resolve(strict=True) == location,'PREFIX_MISMATCH')
        exe=Path(executable).resolve(strict=True)
        require(action_exe == exe,'ACTION_OUTPUT_MISMATCH')
        require(exe.is_relative_to(location/'bin'),'EXECUTABLE_MISMATCH')
        lib=(location/'lib').resolve(strict=True)
        require(lib == location/'lib' and lib.is_dir(),'LIBRARY_MISMATCH')
        for path in (cache,location,lib):
            require(path.stat().st_uid in (0,owner),'OWNER_MISMATCH')
    except OSError: raise RuntimePathBlocked('METADATA_IO_ERROR') from None
    return str(lib)
