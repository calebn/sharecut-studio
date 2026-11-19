import unittest
from classify import classify, pair

class Classification(unittest.TestCase):
    def setUp(self):
        self.good = [{"ordinal": n, "status": "PASS"} for n in range(1, 13)]
        self.red = self.good[:4] + [{"ordinal": 5, "status": "REGRESSION"}, {"ordinal": 12, "status": "PASS"}]
        self.passed = {"count": 1, "status": "passed", "global_errors": 0, "hook_errors": 0, "errors": 0, "error_kind": "none"}
        self.failed = {"count": 1, "status": "failed", "global_errors": 0, "hook_errors": 0, "errors": 1, "error_kind": "controlled_regression"}
    def test_pair(self):
        self.assertEqual(pair(classify(self.red,self.failed,1,"PASS"),classify(self.good,self.passed,0,"PASS")),"BEHAVIOR_CONFIRMED")
    def test_setup_failure(self):
        self.assertEqual(classify([],self.failed,1,"PASS"),"BLOCKED")
    def test_wrong_assertion(self):
        self.assertEqual(classify(self.good[:3],self.failed,1,"PASS"),"BLOCKED")
    def test_cleanup_failure(self):
        self.assertEqual(classify(self.red,self.failed,1,"FAIL"),"BLOCKED")
    def test_duplicate(self):
        self.assertEqual(classify(self.good+self.good[-1:],self.passed,0,"PASS"),"BLOCKED")
    def test_extra_field(self):
        self.good[0]["message"]="do not publish"
        self.assertEqual(classify(self.good,self.passed,0,"PASS"),"BLOCKED")
    def test_timeout(self):
        self.assertEqual(classify(self.red,{**self.failed,"status":"timedOut"},1,"PASS"),"BLOCKED")
    def test_global_error(self):
        self.assertEqual(classify(self.good,{**self.passed,"global_errors":1},0,"PASS"),"BLOCKED")
    def test_second_test(self):
        self.assertEqual(classify(self.good,{**self.passed,"count":2},0,"PASS"),"BLOCKED")
    def test_parent_pass_is_not_repro(self):
        self.assertEqual(pair("PASS","PASS"),"BLOCKED")
    def test_head_failure_is_not_confirmation(self):
        self.assertEqual(pair("EXPECTED_REGRESSION","EXPECTED_REGRESSION"),"BLOCKED")
    def test_wrong_exit(self):
        self.assertEqual(classify(self.red,self.failed,0,"PASS"),"BLOCKED")

    def test_observed_regression_but_helper_restore_fails(self):
        self.assertEqual(classify(self.red[:-1],self.failed,1,"PASS"),"BLOCKED")
    def test_observed_regression_but_wrapper_cleanup_fails(self):
        self.assertEqual(classify(self.red,self.failed,1,"FAIL"),"BLOCKED")
    def test_extra_test_error(self):
        self.assertEqual(classify(self.red,{**self.failed,"errors":2},1,"PASS"),"BLOCKED")
    def test_hook_error(self):
        self.assertEqual(classify(self.red,{**self.failed,"hook_errors":1},1,"PASS"),"BLOCKED")
    def test_wrong_error_after_observation(self):
        self.assertEqual(classify(self.red,{**self.failed,"error_kind":"other"},1,"PASS"),"BLOCKED")
    def test_head_extra_error(self):
        self.assertEqual(classify(self.good,{**self.passed,"errors":1},0,"PASS"),"BLOCKED")
    def test_head_missing_helper_restore(self):
        self.assertEqual(classify(self.good[:-1],self.passed,0,"PASS"),"BLOCKED")

if __name__ == "__main__": unittest.main()
