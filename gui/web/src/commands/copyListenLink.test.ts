import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { hostShareRow, minimalProject } from "../test/fixtures";
import { COMMANDS } from "./catalog";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

const api = vi.hoisted(() => ({ listShares: vi.fn(), createShare: vi.fn() }));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    listHostShares: (...args: unknown[]) => api.listShares(...args),
    createHostShare: (...args: unknown[]) => api.createShare(...args),
  };
});

const LISTEN = hostShareRow({
  token: "listen-1",
  url: "https://example.test/r/listen-1",
  docs_role: "viewer",
  follow_latest: false,
});

describe("share.copyListenLink", () => {
  const writeText = vi.fn();

  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    api.listShares.mockReset();
    api.createShare.mockReset();
    writeText.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.setState({ statusAnnouncement: "" });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("is a palette command with no key of its own: the design system drops the chord", () => {
    expect(COMMANDS["share.copyListenLink"]).toMatchObject({
      label: "Copy listen link",
      when: "hostProjectLoaded",
    });
  });

  it("copies the listen link that exists without making another", async () => {
    api.listShares.mockResolvedValue({ shares: [hostShareRow(), LISTEN] });
    expect(await execute("share.copyListenLink")).toEqual({ status: "ok" });
    expect(writeText).toHaveBeenCalledWith("https://example.test/r/listen-1");
    expect(api.createShare).not.toHaveBeenCalled();
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Listen link copied",
    );
  });

  it("makes a Viewer link frozen on the version when there is none, then copies it", async () => {
    api.listShares.mockResolvedValue({ shares: [hostShareRow()] });
    api.createShare.mockResolvedValue(LISTEN);
    expect(await execute("share.copyListenLink")).toEqual({ status: "ok" });
    expect(api.createShare).toHaveBeenCalledWith("/tmp/p.json", {
      role: "viewer",
      with_mcp: false,
      freeze: true,
    });
    expect(writeText).toHaveBeenCalledWith("https://example.test/r/listen-1");
  });

  it("says why when the link cannot be made", async () => {
    api.listShares.mockResolvedValue({ shares: [] });
    api.createShare.mockRejectedValue(new Error("No mix yet"));
    const result = await execute("share.copyListenLink");
    expect(result).toEqual({ status: "disabled", reason: "No mix yet" });
    expect(writeText).not.toHaveBeenCalled();
    expect(useDawStore.getState().statusAnnouncement).toBe("No mix yet");
  });
});
