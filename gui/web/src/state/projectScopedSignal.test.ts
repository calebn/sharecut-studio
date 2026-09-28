import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "./dawStore";
import { projectScopedSignal } from "./projectScopedSignal";

describe("projectScopedSignal", () => {
  beforeEach(() => {
    useDawStore.setState({ projectPath: "/tmp/a.project.json" });
  });

  it("aborts when the project path changes", () => {
    const { signal } = projectScopedSignal("/tmp/a.project.json");
    useDawStore.setState({ projectPath: "/tmp/b.project.json" });
    expect(signal.aborted).toBe(true);
    expect((signal.reason as DOMException).name).toBe("AbortError");
  });

  it("ignores other store changes", () => {
    const { signal } = projectScopedSignal("/tmp/a.project.json");
    useDawStore.setState({ statusAnnouncement: "x" });
    expect(signal.aborted).toBe(false);
  });

  it("stops watching after dispose", () => {
    const { signal, dispose } = projectScopedSignal("/tmp/a.project.json");
    dispose();
    useDawStore.setState({ projectPath: "/tmp/b.project.json" });
    expect(signal.aborted).toBe(false);
  });
});
