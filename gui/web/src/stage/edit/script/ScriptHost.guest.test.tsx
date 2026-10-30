import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../../state/dawStore";
import { COMMENTER_CAPABILITIES } from "../../../test/fixtures";
import { seedScript } from "../../../test/scriptHostKit";
import { ScriptHost } from "./ScriptHost";

const seekTransport = vi.hoisted(() => vi.fn());
vi.mock("../../../commands/seek", () => ({ seekTransport }));

const EDITOR = [...COMMENTER_CAPABILITIES, "edit"];
const word = (name: string) => screen.getByRole("button", { name });
const speakers = () =>
  screen.queryAllByRole("button", { name: /change speaker/ });
const fixOpens = async () => {
  await userEvent.dblClick(word("show"));
  return screen.queryByRole("textbox") !== null;
};

beforeEach(() => {
  seekTransport.mockReset();
});

describe("ScriptHost host", () => {
  it("offers everything and labels nobody a guest", async () => {
    seedScript();
    render(<ScriptHost />);
    expect(screen.queryByText(/Read only/)).toBeNull();
    expect(speakers().length).toBeGreaterThan(0);
    expect(await fixOpens()).toBe(true);
  });

  it("offers Replace in the Find bar", async () => {
    seedScript();
    render(<ScriptHost />);
    await userEvent.click(
      screen.getByRole("button", { name: "Find in transcript" }),
    );
    expect(
      screen.getByRole("button", { name: "Show replace" }),
    ).toBeInTheDocument();
  });
});

describe("ScriptHost guest matrix", () => {
  it("lets a viewer read and seek, and nothing else", async () => {
    seedScript({
      projectPath: "share:abc",
      guestMode: "view",
      shareCapabilities: ["play", "view"],
    });
    render(<ScriptHost />);
    expect(screen.getByText("Read only")).toBeInTheDocument();
    await userEvent.click(word("back"));
    expect(seekTransport).toHaveBeenCalledWith(10.5);
    expect(useDawStore.getState().selection).toBeNull();
    expect(speakers()).toHaveLength(0);
    expect(
      screen.queryByRole("button", { name: /unsure words?, go to/ }),
    ).toBeNull();
    expect(await fixOpens()).toBe(false);
  });

  it("lets a commenter select and find, but not fix or replace", async () => {
    seedScript({
      projectPath: "share:abc",
      guestMode: "comment",
      shareCapabilities: COMMENTER_CAPABILITIES,
    });
    render(<ScriptHost />);
    expect(screen.getByText("Read only · you can comment")).toBeInTheDocument();
    await userEvent.click(word("back"));
    expect(useDawStore.getState().selection).toMatchObject({
      kind: "transcriptRange",
      startWordIndex: 1,
    });
    expect(speakers()).toHaveLength(0);
    expect(await fixOpens()).toBe(false);
    await userEvent.click(
      screen.getByRole("button", { name: "Find in transcript" }),
    );
    expect(screen.getByRole("search")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show replace" })).toBeNull();
  });

  it("lets an edit-share guest select and rename speakers, but not fix text or replace", async () => {
    seedScript({
      projectPath: "share:abc",
      guestMode: "edit",
      shareCapabilities: EDITOR,
    });
    render(<ScriptHost />);
    expect(screen.queryByText(/Read only/)).toBeNull();
    await userEvent.click(word("back"));
    expect(useDawStore.getState().selection?.kind).toBe("transcriptRange");
    expect(speakers().length).toBeGreaterThan(0);
    expect(await fixOpens()).toBe(false);
    await userEvent.click(
      screen.getByRole("button", { name: "Find in transcript" }),
    );
    expect(screen.queryByRole("button", { name: "Show replace" })).toBeNull();
  });

  it("passes no select when the share cannot change ranges, whatever the guest mode", async () => {
    seedScript({
      projectPath: "share:abc",
      guestMode: "edit",
      shareCapabilities: ["play", "view"],
    });
    render(<ScriptHost />);
    await userEvent.click(word("back"));
    expect(useDawStore.getState().selection).toBeNull();
    expect(screen.getByText("Read only")).toBeInTheDocument();
  });
});
