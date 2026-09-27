import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { buildCommandContext, evaluateWhen } from "./context";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

describe("layout and tab commands", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.setState({
      layoutMode: "default",
      shellBreakpoint: "desktop",
      activeTab: "transcript",
    });
  });

  it("view.setTab from the timeline layout shows the tab", async () => {
    useDawStore.setState({ layoutMode: "timeline" });
    expect((await execute("view.setTab", { tab: "comments" })).status).toBe(
      "ok",
    );
    expect(useDawStore.getState().layoutMode).toBe("default");
    expect(useDawStore.getState().activeTab).toBe("comments");
  });

  it("view.setTab keeps a layout that already shows the tab", async () => {
    useDawStore.getState().setLayoutMode("review");
    await execute("view.setTab", { tab: "comments" });
    expect(useDawStore.getState().layoutMode).toBe("review");
    useDawStore.getState().setLayoutMode("default");
  });

  it("layout commands are disabled on the phone shell", async () => {
    useDawStore.setState({ shellBreakpoint: "phone" });
    const result = await execute("layout.timeline");
    expect(result.status).toBe("disabled");
    expect(useDawStore.getState().layoutMode).toBe("default");
    useDawStore.setState({ shellBreakpoint: "desktop" });
    expect((await execute("layout.timeline")).status).toBe("ok");
    expect(useDawStore.getState().layoutMode).toBe("timeline");
  });

  it("tighten keys are off while the timeline layout hides the panel", () => {
    useDawStore.setState({ activeTab: "tighten", layoutMode: "timeline" });
    expect(evaluateWhen("tightenPanelOpen", buildCommandContext()).ok).toBe(
      false,
    );
    useDawStore.setState({ layoutMode: "default" });
    expect(evaluateWhen("tightenPanelOpen", buildCommandContext()).ok).toBe(
      true,
    );
  });
});
