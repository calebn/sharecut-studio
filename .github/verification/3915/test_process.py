import io
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from setup_support import checked_process, SetupBlocked, python_library_directory

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
        source={'RUNNER_TOOL_CACHE':'/__t','pythonLocation':'/__t/Python/3.12.16/x64','LD_LIBRARY_PATH':'/untrusted'}
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

if __name__=='__main__': unittest.main()
