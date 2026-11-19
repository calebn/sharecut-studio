import io
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from setup_support import checked_process, SetupBlocked, python_library_directory, RuntimePathBlocked

class ProcessOutcomes(unittest.TestCase):
    def check(self, result=None, error=None):
        records=[]
        def receipt(*args): records.append(args)
        with patch('setup_support.subprocess.run', return_value=result, side_effect=error):
            try: checked_process(['fabricated'],'.',{},io.BytesIO(),receipt,31)
            except SetupBlocked: pass
        return records
    def test_success(self):
        self.assertEqual(self.check(subprocess.CompletedProcess([],0)),[(31,'PASS','NONE')])
    def test_nonzero(self):
        self.assertEqual(self.check(subprocess.CompletedProcess([],127)),[(31,'BLOCKED','EXIT_NONZERO')])
    def test_spawn(self):
        self.assertEqual(self.check(error=FileNotFoundError('private diagnostics')),[(31,'BLOCKED','SPAWN_FAILED')])
    def test_permission(self):
        self.assertEqual(self.check(error=PermissionError('private path')),[(31,'BLOCKED','SPAWN_FAILED')])
    def test_timeout(self):
        self.assertEqual(self.check(error=subprocess.TimeoutExpired('private command',1)),[(31,'BLOCKED','TIMEOUT')])

class RuntimePathValidation(unittest.TestCase):
    def validate(self, **changes):
        source={'RUNNER_TOOL_CACHE':'/__t','pythonLocation':'/__t/Python/3.12.16/x64','LD_LIBRARY_PATH':'/untrusted','V3915_PYTHON_PATH':'/__t/Python/3.12.16/x64/bin/python','V3915_PYTHON_VERSION':'3.12.16'}
        source.update(changes)
        with patch.object(Path,'resolve',lambda self,strict=True:self), patch.object(Path,'is_dir',return_value=True), patch.object(Path,'stat',return_value=SimpleNamespace(st_uid=0)):
            return python_library_directory(source,'/__t/Python/3.12.16/x64/bin/python','/__t/Python/3.12.16/x64','3.12.16',owner=1000)
    def test_only_action_lib_not_inherited_suffix(self):
        self.assertEqual(self.validate(),'/__t/Python/3.12.16/x64/lib')
    def test_unrecognized_cache(self):
        with self.assertRaises(SetupBlocked):self.validate(RUNNER_TOOL_CACHE='/tmp/arbitrary')
    def test_wrong_python_location(self):
        with self.assertRaises(SetupBlocked):self.validate(pythonLocation='/__t/Python/3.12.15/x64')
    def test_missing_location(self):
        with self.assertRaises(SetupBlocked):self.validate(pythonLocation='')

    def test_action_cache_override_matches_pinned_source(self):
        self.assertEqual(self.validate(AGENT_TOOLSDIRECTORY='/__t', RUNNER_TOOL_CACHE='/unmapped'),'/__t/Python/3.12.16/x64/lib')
    def test_wrong_action_executable(self):
        with self.assertRaises(RuntimePathBlocked) as ctx:self.validate(V3915_PYTHON_PATH='/unrelated/bin/python')
        self.assertEqual(ctx.exception.code,'ACTION_OUTPUT_MISMATCH')
    def test_wrong_action_version(self):
        with self.assertRaises(RuntimePathBlocked) as ctx:self.validate(V3915_PYTHON_VERSION='3.12.15')
        self.assertEqual(ctx.exception.code,'VERSION_MISMATCH')
    def test_unknown_cache_remains_blocked(self):
        with self.assertRaises(RuntimePathBlocked) as ctx:self.validate(AGENT_TOOLSDIRECTORY='/untrusted')
        self.assertEqual(ctx.exception.code,'CACHE_ROOT_UNRECOGNIZED')
    def test_missing_action_output(self):
        with self.assertRaises(RuntimePathBlocked) as ctx:self.validate(V3915_PYTHON_PATH='')
        self.assertEqual(ctx.exception.code,'ACTION_OUTPUT_MISSING')

if __name__=='__main__': unittest.main()
