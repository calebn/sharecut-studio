import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { minimalProject } from "../../test/fixtures";
import { useHeaderProps } from "./useHeaderProps";

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore
    .getState()
    .hydrate("/tmp/header-props/episode.sharecut", minimalProject());
  useDawStore.setState({ guestMode: null });
  useDawStore.getState().setHelpDialogOpen(false);
});

describe("useHeaderProps Project menu", () => {
  it("opens Help on its three rows, not on the report step", () => {
    const { result } = renderHook(() => useHeaderProps());
    result.current.onMenuCommand?.("help");
    const { helpDialogOpen, helpDialogStep } = useDawStore.getState().chrome;
    expect(helpDialogOpen).toBe(true);
    expect(helpDialogStep).toBe("menu");
  });
});

describe("useHeaderProps title", () => {
  const project = () => ({ ...minimalProject(), meta: { name: "Real name" } });

  it("is the episode's name once the project is read", () => {
    useDawStore.getState().hydrate("/tmp/x.sharecut", project());
    const { result } = renderHook(() => useHeaderProps());
    expect(result.current.title).toBe("Real name");
    expect(result.current.loading).toBe(false);
  });

  it("is the name the link answered with, for a guest, until the project is read", () => {
    useDawStore
      .getState()
      .hydrate(
        "share:tok",
        null,
        "comment",
        ["view"],
        null,
        false,
        "From the link",
      );
    const { result } = renderHook(() => useHeaderProps());
    expect(result.current.title).toBe("From the link");
    expect(result.current.loading).toBe(true);
  });

  it("is Episode for a guest with no name, and Project for a host", () => {
    useDawStore
      .getState()
      .hydrate("share:tok", null, "comment", ["view"], null, false, null);
    const guest = renderHook(() => useHeaderProps());
    expect(guest.result.current.title).toBe("Episode");
    guest.unmount();
    useDawStore.getState().hydrate("/tmp/host.sharecut", null);
    useDawStore.setState({ guestMode: null });
    const host = renderHook(() => useHeaderProps());
    expect(host.result.current.title).toBe("Project");
  });
});
