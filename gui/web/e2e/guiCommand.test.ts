import { describe, expect, it } from "vitest";
import { guiCommand, podcastCommand } from "./guiCommand";

describe("guiCommand", () => {
  const base = {
    ci: false,
    host: "127.0.0.1",
    port: 43123,
    projectPath: "/tmp/sharecut-e2e/episode.project.json",
  };

  it.each([
    { ci: false, command: ["uv", "run", "--extra", "gui", "podcast"] },
    { ci: true, command: ["podcast"] },
  ])("selects the installed podcast runner for ci=$ci", ({ ci, command }) => {
    expect(podcastCommand({ ci })).toEqual(command);
  });

  it("leaves ordinary loopback E2E unpinned", () => {
    expect(guiCommand({ ...base, pinProject: false })).toEqual([
      "uv",
      "run",
      "--extra",
      "gui",
      "podcast",
      "gui",
      "--host",
      "127.0.0.1",
      "--port",
      "43123",
      "--no-open",
    ]);
  });

  it("pins the explicit UX screenshot project", () => {
    expect(guiCommand({ ...base, ci: true, pinProject: true })).toEqual([
      "podcast",
      "gui",
      "--project",
      "/tmp/sharecut-e2e/episode.project.json",
      "--host",
      "127.0.0.1",
      "--port",
      "43123",
      "--no-open",
    ]);
  });
});
