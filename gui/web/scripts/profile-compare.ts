import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  applyDiagnosticBudget,
  type FrozenDiagnosticBudget,
  freezeDiagnosticBudget,
  type ProfileEvidence,
} from "../e2e/editorProfileBudget";
import {
  type EditorProfileReport,
  failureReason,
  hash,
} from "../e2e/editorProfileReport";

const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    holdout: { type: "string" },
    budget: { type: "string" },
    candidate: { type: "string" },
    out: { type: "string" },
  },
});
const creating =
  !!values.baseline && !!values.holdout && !values.budget && !values.candidate;
const applying =
  !!values.budget && !!values.candidate && !values.baseline && !values.holdout;
if (!values.out || (!creating && !applying))
  throw new Error(
    "Create: profile:compare -- --baseline DIR --holdout INDEPENDENT_DIR --out NEW_BUDGET; apply: --budget FROZEN_FILE --candidate DIR --out NEW_RESULT",
  );
if (fs.existsSync(values.out))
  throw new Error("Refusing to replace retained budget/evidence");
function readFile(filename: string): ProfileEvidence {
  try {
    const bytes = fs.readFileSync(filename);
    const report = JSON.parse(bytes.toString("utf8")) as EditorProfileReport;
    if (
      report.schemaVersion !== 1 ||
      !Array.isArray(report.samples) ||
      !report.execution?.id ||
      !report.execution.startedAt ||
      !report.fixture?.canonicalSha256 ||
      !report.environment?.host ||
      !report.protocol ||
      !Array.isArray(report.coverage) ||
      !Array.isArray(report.memory) ||
      !["complete", "incomplete"].includes(report.status)
    )
      throw new Error("missing report shape or execution provenance");
    return { file: fs.realpathSync(filename), sha256: hash(bytes), report };
  } catch (error) {
    throw new Error(`Invalid report ${filename}: ${failureReason(error)}`);
  }
}
function read(root: string): ProfileEvidence[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(root, entry.name);
    if (entry.isDirectory() && entry.name !== "fixture") return read(filename);
    return entry.isFile() && entry.name === "report.json"
      ? [readFile(filename)]
      : [];
  });
}
let result:
  | ReturnType<typeof freezeDiagnosticBudget>
  | (ReturnType<typeof applyDiagnosticBudget> & {
      budgetFile: string;
      budgetSha256: string;
    });
if (creating) {
  if (fs.realpathSync(values.baseline!) === fs.realpathSync(values.holdout!))
    throw new Error("Holdout must be independent of baseline");
  result = freezeDiagnosticBudget(
    read(values.baseline!),
    read(values.holdout!),
  );
} else {
  const bytes = fs.readFileSync(values.budget!);
  let budget: FrozenDiagnosticBudget;
  try {
    budget = JSON.parse(bytes.toString("utf8"));
    if (
      budget.schemaVersion !== 1 ||
      budget.kind !== "editor-local-diagnostic-budget" ||
      !Array.isArray(budget.groups) ||
      !budget.groups.every(
        (group) =>
          !!group &&
          Array.isArray(group.baseline) &&
          Array.isArray(group.holdout) &&
          Array.isArray(group.metrics) &&
          [...group.baseline, ...group.holdout].every(
            (reference) =>
              !!reference &&
              [reference.file, reference.sha256, reference.executionId].every(
                (value) => typeof value === "string" && value.length > 0,
              ),
          ),
      )
    )
      throw new Error("invalid frozen budget shape");
  } catch (error) {
    throw new Error(`Invalid budget ${values.budget}: ${failureReason(error)}`);
  }
  const references = budget.groups.flatMap((group) => [
    ...group.baseline,
    ...group.holdout,
  ]);
  const originals = [
    ...new Set(references.map((reference) => reference.file)),
  ].map(readFile);
  result = {
    ...applyDiagnosticBudget(budget, originals, read(values.candidate!)),
    budgetFile: fs.realpathSync(values.budget!),
    budgetSha256: hash(bytes),
  };
}
fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
fs.writeFileSync(values.out, `${JSON.stringify(result, null, 2)}\n`, {
  flag: "wx",
});
process.exitCode = ["validated", "within-local-envelope"].includes(
  result.status,
)
  ? 0
  : 1;
