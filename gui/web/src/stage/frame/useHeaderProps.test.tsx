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
