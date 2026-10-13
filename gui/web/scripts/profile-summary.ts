import fs from "node:fs";
import path from "node:path";
import type { EditorProfileReport } from "../e2e/editorProfileReport";
import { formatSummary } from "../e2e/editorProfileSummary";

const root = process.argv[2];
if (!root) throw new Error("Usage: profile:summary -- DIRECTORY");

function reports(directory: string): EditorProfileReport[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory())
      return entry.name === "fixture" ? [] : reports(file);
    return entry.name === "report.json"
      ? [JSON.parse(fs.readFileSync(file, "utf8")) as EditorProfileReport]
      : [];
  });
}

const found = reports(path.resolve(root));
if (!found.length) throw new Error(`No report.json under ${root}`);
const text = formatSummary(found);
fs.writeFileSync(path.join(path.resolve(root), "summary.txt"), text);
process.stdout.write(text);
process.exitCode = found.some((report) => report.status !== "complete") ? 1 : 0;
