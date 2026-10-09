import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  control,
  invoke,
  readJson,
  restoreInvocation,
} from "./profile-editing-tasks.fixture";

afterEach(restoreInvocation);

const processPhases = [
  {
    phase: "backend",
    diagnostic: "Backend import provenance",
    command: "uv run python -c",
  },
  {
    phase: "build",
    diagnostic: "Production build",
    command: "npm run build",
  },
] as const;

function expectRejectedBeforeAdmission(
  result: Awaited<ReturnType<typeof invoke>>,
  phase: "backend" | "build",
  retainedBackendText = false,
) {
  expect(result.summary).toBe(null);
  expect(result.attempts).toBe(null);
  expect(control.launched).toEqual([]);
  expect(fs.existsSync(path.join(control.out, "protocol.json"))).toBe(false);
  expect(fs.existsSync(path.join(control.out, "protocol.sha256"))).toBe(false);
  expect(fs.existsSync(path.join(control.out, "build.json"))).toBe(false);
  expect(fs.existsSync(path.join(control.out, "production-dist"))).toBe(false);
  expect(fs.existsSync(path.join(control.out, "production-build.log"))).toBe(
    false,
  );
  if (phase === "backend")
    expect(fs.existsSync(path.join(control.out, "backend-import.log"))).toBe(
      retainedBackendText,
    );
  else
    expect(readJson(path.join(control.out, "backend-import.log"))).toEqual({
      cwd: control.repo,
      executable: "controlled-backend-import-boundary",
      module: path.join(control.repo, "src/podcast_mcp/gui/server.py"),
    });
}

it.each(processPhases)(
  "retains the actual ENOENT cause for $phase spawn failure before log retention",
  async ({ phase, diagnostic, command }) => {
    const result = await invoke("complete", {
      processFault: { phase, kind: "spawn-error" },
    });
    expect(result.processResult).toMatchObject({
      status: null,
      signal: null,
      error: { code: "ENOENT", path: control.missingExecutable, spawnargs: [] },
    });
    expect(result.processResult!.stdout).toBeUndefined();
    expect(result.processResult!.stderr).toBeUndefined();
    expect(result.rejection).toContain(diagnostic);
    expect(result.rejection).toContain(command);
    expect(result.rejection).toContain("ENOENT");
    expect(result.caughtError).toBeInstanceOf(Error);
    expect((result.caughtError as Error).cause).toBe(
      result.processResult!.error,
    );
    expectRejectedBeforeAdmission(result, phase);
  },
  120000,
);

it.each(processPhases)(
  "retains native status 23 and literal stderr for $phase failure before log retention",
  async ({ phase, diagnostic, command }) => {
    const result = await invoke("complete", {
      processFault: { phase, kind: "nonzero" },
    });
    expect(result.rejection).toContain(diagnostic);
    expect(result.rejection).toContain(command);
    expect(result.rejection).toMatch(/status\s*[:=]?\s*23/i);
    expect(result.rejection).toContain("literal process boundary failure");
    expect(result.processResult).toMatchObject({
      status: 23,
      signal: null,
      stdout: "",
      stderr: "literal process boundary failure\n",
    });
    expect(result.processResult!.error).toBeUndefined();
    expectRejectedBeforeAdmission(result, phase);
  },
  120000,
);

it.each(processPhases)(
  "retains native SIGTERM and literal stderr for $phase failure before log retention",
  async ({ phase, diagnostic, command }) => {
    const result = await invoke("complete", {
      processFault: { phase, kind: "signal" },
    });
    expect(result.rejection).toContain(diagnostic);
    expect(result.rejection).toContain(command);
    expect(result.rejection).toContain("SIGTERM");
    expect(result.rejection).toMatch(/status\s*[:=]?\s*null/i);
    expect(result.rejection).toContain("literal process signal failure");
    expect(result.processResult).toMatchObject({
      status: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "literal process signal failure\n",
    });
    expect(result.processResult!.error).toBeUndefined();
    expectRejectedBeforeAdmission(result, phase);
  },
  120000,
);

it.each(processPhases)(
  "rejects missing UTF8 stdout from nominal $phase success before log retention",
  async ({ phase, diagnostic, command }) => {
    const result = await invoke("complete", {
      processFault: { phase, kind: "missing-stdout" },
    });
    expect(result.rejection).toContain(diagnostic);
    expect(result.rejection).toContain(command);
    expect(result.rejection).toContain("expected UTF8 stdout/stderr");
    expect(result.processResult).toMatchObject({
      status: 0,
      signal: null,
      stdout: null,
      stderr: "",
    });
    expectRejectedBeforeAdmission(result, phase);
  },
  120000,
);

it.each(processPhases)(
  "rejects missing UTF8 stderr from nominal $phase success before log retention",
  async ({ phase, diagnostic, command }) => {
    const result = await invoke("complete", {
      processFault: { phase, kind: "missing-stderr" },
    });
    expect(result.rejection).toContain(diagnostic);
    expect(result.rejection).toContain(command);
    expect(result.rejection).toContain("expected UTF8 stdout/stderr");
    expect(result.processResult).toMatchObject({
      status: 0,
      signal: null,
      stderr: null,
    });
    expect(typeof result.processResult!.stdout).toBe("string");
    expectRejectedBeforeAdmission(result, phase);
  },
  120000,
);

it("rejects invalid backend JSON through the actual producer parser and retains the text log", async () => {
  const result = await invoke("complete", {
    processFault: { phase: "backend", kind: "invalid-json" },
  });
  expect(result.caughtError).toBeInstanceOf(SyntaxError);
  expect(result.rejection).toMatch(/SyntaxError:.*JSON/i);
  expect(
    fs.readFileSync(path.join(control.out, "backend-import.log"), "utf8"),
  ).toBe("literal invalid JSON\n");
  expectRejectedBeforeAdmission(result, "backend", true);
}, 120000);

it.each([
  { label: "null record", metadata: () => null },
  { label: "array record", metadata: () => [] },
  {
    label: "nontext cwd",
    metadata: (repo: string) => ({
      cwd: 23,
      executable: "literal executable",
      module: path.join(repo, "src/podcast_mcp/gui/server.py"),
    }),
  },
  {
    label: "missing executable",
    metadata: (repo: string) => ({
      cwd: repo,
      module: path.join(repo, "src/podcast_mcp/gui/server.py"),
    }),
  },
  {
    label: "empty executable",
    metadata: (repo: string) => ({
      cwd: repo,
      executable: "",
      module: path.join(repo, "src/podcast_mcp/gui/server.py"),
    }),
  },
  {
    label: "nontext module",
    metadata: (repo: string) => ({
      cwd: repo,
      executable: "literal executable",
      module: null,
    }),
  },
])(
  "rejects backend $label as invalid metadata before protocol admission",
  async ({ metadata }) => {
    const repo = path.resolve(process.cwd(), "../..");
    const record = metadata(repo);
    const result = await invoke("complete", {
      processFault: {
        phase: "backend",
        kind: "invalid-metadata",
        metadata: record,
      },
    });
    expect(result.rejection).toContain(
      "Backend import provenance returned invalid metadata",
    );
    expect(
      fs.readFileSync(path.join(control.out, "backend-import.log"), "utf8"),
    ).toBe(`${JSON.stringify(record)}\n`);
    expectRejectedBeforeAdmission(result, "backend", true);
  },
  120000,
);
