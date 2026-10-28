import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadHostRecordState } from "./api";
import { DawApp } from "./dawApp";
import { RecordPanel } from "./record/RecordPanel";
import { useDawStore } from "./state/dawStore";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  loadHostRecordState: vi.fn(async () => null),
}));
vi.mock("./record/RecordPanel", () => ({ RecordPanel: vi.fn(() => null) }));
vi.mock("./TransportEngine", () => ({
  TransportEngine: () => null,
  FollowEngine: () => null,
}));
vi.mock("./stage/frame/StageFrame", () => ({ StageFrame: () => null }));
vi.mock("./stage/frame/useLandingStage", () => ({ useLandingStage: () => {} }));
vi.mock("./stage/dialogs/BounceDialog", () => ({ BounceDialog: () => null }));
vi.mock("./stage/dialogs/CheatsheetDialogs", () => ({
  CheatsheetDialogs: () => null,
}));
vi.mock("./stage/dialogs/ExportDialog", () => ({ ExportDialog: () => null }));
vi.mock("./stage/dialogs/HostMcpDialog", () => ({
  HostMcpDialog: () => null,
}));
vi.mock("./stage/dialogs/ShareDialog", () => ({ ShareDialog: () => null }));
vi.mock("./feedback/AskDialog", () => ({ AskDialog: () => null }));
vi.mock("./feedback/FeedbackToast", () => ({ FeedbackToast: () => null }));
vi.mock("./home/HelpDialog", () => ({ HelpDialog: () => null }));
vi.mock("./models", () => ({ ModelsDialog: () => null }));
vi.mock("./agentic/webmcp", () => ({ registerDawWebMcpTools: () => () => {} }));
vi.mock("./desktop/useDesktopCloseGuard", () => ({
  useDesktopCloseGuard: () => {},
}));
vi.mock("./hooks/useAutoRefreshMix", () => ({ useAutoRefreshMix: () => {} }));
vi.mock("./hooks/useGuestSyncAndProjectPoll", () => ({
  useGuestSyncAndProjectPoll: () => {},
}));
vi.mock("./hooks/useHostSync", () => ({ useHostSync: () => {} }));
vi.mock("./hooks/usePendingMixWarm", () => ({ usePendingMixWarm: () => {} }));
vi.mock("./hooks/usePipelineJob", () => ({ usePipelineJob: () => {} }));
vi.mock("./hooks/useProjectBootstrap", () => ({
  useProjectBootstrap: () => ({
    error: null,
    recovering: false,
    retry: () => {},
  }),
}));
vi.mock("./keymap/listener", () => ({ useDawKeymapListener: () => {} }));
vi.mock("./record/monitor/useRecordMonitor", () => ({
  useRecordMonitor: () => ({ hearing: false, remoteCount: 0, error: null }),
}));
vi.mock("./record/useHostKeeperCapture", () => ({
  useHostKeeperCapture: () => ({
    recordingLocally: false,
    finalizing: false,
    error: null,
    snapshot: null,
    stream: null,
    muted: false,
    monitorEnabled: false,
    micError: null,
    micPending: false,
    micStatus: null,
    micLost: false,
    micCheckFailed: false,
    retry: () => {},
    retryMic: () => {},
    checkMic: () => {},
  }),
}));

describe("DawApp host room", () => {
  beforeEach(() => {
    vi.mocked(loadHostRecordState).mockClear();
    useDawStore.setState({ projectPath: "/p" });
    useDawStore.getState().setRecordPanelOpen(false);
  });

  it("provides the room to RecordPanel and fetches only once the panel opens", async () => {
    render(<DawApp />);
    await act(async () => undefined);
    expect(RecordPanel).toHaveBeenCalled();
    expect(loadHostRecordState).not.toHaveBeenCalled();
    act(() => useDawStore.getState().setRecordPanelOpen(true));
    await act(async () => undefined);
    expect(loadHostRecordState).toHaveBeenCalledTimes(1);
  });

  it("never fetches for a guest share, even with the panel open", async () => {
    useDawStore.getState().setRecordPanelOpen(true);
    render(<DawApp guestShare />);
    await act(async () => undefined);
    expect(loadHostRecordState).not.toHaveBeenCalled();
  });
});
