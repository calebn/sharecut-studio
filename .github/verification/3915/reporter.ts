import fs from "node:fs";
import type { Reporter, TestCase, TestResult, TestStep, FullResult } from "@playwright/test/reporter";
export default class Ordinals implements Reporter {
  count=0; status="unknown"; global_errors=0; hook_errors=0; errors=0; error_kind="none";
  printsToStdio() { return false; }
  onStepEnd(_test:TestCase,_result:TestResult,step:TestStep) {
    if (step.category === "hook" && step.error) this.hook_errors++;
  }
  onTestEnd(_test:TestCase,result:TestResult) {
    this.count++; this.status=result.status; this.errors+=result.errors.length;
    if (result.errors.length) this.error_kind = result.errors.length === 1 &&
      ["V3915_EXPECTED_REGRESSION","Error: V3915_EXPECTED_REGRESSION"].includes(result.errors[0].message ?? "")
      ? "controlled_regression" : "other";
  }
  onError() { this.global_errors++; }
  onEnd(result:FullResult) {
    if (result.status !== "passed" && result.status !== "failed") this.global_errors++;
    fs.writeFileSync(process.env.V3915_RESULT!, JSON.stringify({count:this.count,status:this.status,
      global_errors:this.global_errors,hook_errors:this.hook_errors,errors:this.errors,error_kind:this.error_kind}));
  }
}
