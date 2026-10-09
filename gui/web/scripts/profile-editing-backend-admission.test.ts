import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  control,
  invoke,
  restoreInvocation,
} from "./profile-editing-tasks.fixture";

afterEach(restoreInvocation);

it.each([
  {
    label: "another admitted Python module",
    suffix: "/src/podcast_mcp/cli/main.py",
  },
  { label: "traversal to project metadata", suffix: "/src/../pyproject.toml" },
  {
    label: "traversal to unadmitted instructions",
    suffix: "/src/../AGENTS.md",
  },
])(
  "rejects backend $label before protocol admission",
  async ({ suffix }) => {
    const repo = path.resolve(process.cwd(), "../..");
    const metadata = {
      cwd: repo,
      executable: "controlled-backend-import-boundary",
      module: repo + suffix,
    };
    const result = await invoke("complete", {
      processFault: { phase: "backend", kind: "invalid-metadata", metadata },
    });
    expect(result.rejection).toContain(
      "Backend import does not match admitted server source",
    );
    expect(
      JSON.parse(
        fs.readFileSync(path.join(control.out, "backend-import.log"), "utf8"),
      ),
    ).toEqual(metadata);
    expect(result.summary).toBe(null);
    expect(result.attempts).toBe(null);
    expect(control.launched).toEqual([]);
    expect(fs.existsSync(path.join(control.out, "protocol.json"))).toBe(false);
  },
  120000,
);
