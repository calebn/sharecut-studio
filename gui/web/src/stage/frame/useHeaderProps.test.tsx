import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { DawProvider } from "../../state/store";
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
  const project = () => {
    const base = minimalProject();
    return { ...base, meta: { ...base.meta, name: "Real name" } };
  };

  it("is the episode's name once the project is read", () => {
    useDawStore.getState().hydrate("/tmp/x.sharecut", project());
    const { result } = renderHook(() => useHeaderProps());
    expect(result.current.title).toBe("Real name");
    expect(result.current.loading).toBe(false);
  });

  const guestShell =
    (shareName: string | null) =>
    ({ children }: { children: ReactNode }) => (
      <DawProvider
        projectPath="share:tok"
        initialProject={null}
        guestMode="comment"
        shareCapabilities={["view"]}
        shareName={shareName}
      >
        {children}
      </DawProvider>
    );

  it("is the name the link answered with, for a guest, until the project is read", () => {
    const { result } = renderHook(() => useHeaderProps(), {
      wrapper: guestShell("From the link"),
    });
    expect(result.current.title).toBe("From the link");
    expect(result.current.loading).toBe(true);
  });

  it("is the link's name in the very first render, before the store is filled", () => {
    useDawStore.getState().hydrate("/tmp/host.sharecut", null);
    const titles: string[] = [];
    renderHook(
      () => {
        const props = useHeaderProps();
        titles.push(props.title);
        return props;
      },
      { wrapper: guestShell("From the link") },
    );
    expect(new Set(titles)).toEqual(new Set(["From the link"]));
  });

  it("is Episode for a guest with no name, and Project for a host", () => {
    const guest = renderHook(() => useHeaderProps(), {
      wrapper: guestShell(null),
    });
    expect(guest.result.current.title).toBe("Episode");
    guest.unmount();
    useDawStore.getState().hydrate("/tmp/host.sharecut", null);
    useDawStore.setState({ guestMode: null });
    const host = renderHook(() => useHeaderProps());
    expect(host.result.current.title).toBe("Project");
  });
});

describe("useHeaderProps role hint", () => {
  const SENTENCE = "You can comment and suggest cuts. The host decides.";

  beforeEach(() => {
    localStorage.clear();
    useDawStore.getState().announceStatus("");
  });

  const asCommenter = (shareCapabilities: string[] | null) =>
    useDawStore.setState({
      projectPath: "share:tok",
      guestMode: "comment",
      shareCapabilities,
    });

  it("says the role's sentence once through the status region, with no toast", () => {
    asCommenter(["view"]);
    const { result } = renderHook(() => useHeaderProps());
    const before = useDawStore.getState().statusAnnouncementSeq;
    act(() => result.current.guest?.hint?.onShown?.());
    const after = useDawStore.getState();
    expect(after.statusAnnouncement).toBe(SENTENCE);
    expect(after.statusAnnouncementSeq).toBe(before + 1);
    expect(after.feedbackToast).toBeNull();
  });

  it("is not shown, and writes no flag, while the guest reads the saved copy", () => {
    asCommenter(null);
    const { result } = renderHook(() => useHeaderProps());
    expect(result.current.guest?.hint?.shown).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it("is shown for the link's role once the server has answered", () => {
    asCommenter(null);
    const { result } = renderHook(() => useHeaderProps());
    expect(result.current.guest?.hint?.shown).toBe(false);
    act(() => asCommenter(["view"]));
    expect(result.current.guest?.hint?.shown).toBe(true);
    expect(result.current.guest?.hint?.text).toBe(SENTENCE);
  });
});
