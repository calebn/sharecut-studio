import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadHostRecordState } from "./api";
import { DawApp } from "./dawApp";
import type { StageFrameProps } from "./stage/frame/StageFrame";
import { useDawStore } from "./state/dawStore";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  loadHostRecordState: vi.fn(async () => null),
}));
vi.mock("./TransportEngine", () => ({
  TransportEngine: () => null,
  FollowEngine: () => null,
}));
const stageHost = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
}));
const retryBootstrap = vi.hoisted(() => vi.fn());
vi.mock("./stage/hosts/StageHost", () => ({
  StageHost: (props: Record<string, unknown>) => {
    stageHost.props.push(props);
    return null;
  },
}));
vi.mock("./stage/frame/StageFrame", () => ({
  StageFrame: ({ children }: Pick<StageFrameProps, "children">) =>
    children({ kind: "available" }),
}));
vi.mock("./stage/frame/useLandingStage", () => ({ useLandingStage: () => {} }));
vi.mock("./stage/dialogs/CommandPalette", () => ({
  CommandPalette: () => null,
}));
vi.mock("./stage/hosts/bounceRunner", () => ({
  BounceRunnerProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./stage/hosts/shareFlow", () => ({
  ShareFlowProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./stage/hosts/exportFlow", () => ({
  ExportFlowProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./stage/dialogs/HostMcpDialog", () => ({
  HostMcpDialog: () => null,
}));
vi.mock("./feedback/FeedbackToast", () => ({ FeedbackToast: () => null }));
vi.mock("./home/HelpDialog", () => ({ HelpDialog: () => null }));
vi.mock("./models", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./models")>()),
  ModelsSheet: () => null,
}));
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
    retrying: false,
    retry: retryBootstrap,
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
    useDawStore.setState({ stage: "edit" });
  });

  it("fetches the room only once the Record stage is active", async () => {
    render(<DawApp />);
    await act(async () => undefined);
    expect(loadHostRecordState).not.toHaveBeenCalled();
    act(() => useDawStore.setState({ stage: "record" }));
    await act(async () => undefined);
    expect(loadHostRecordState).toHaveBeenCalledTimes(1);
  });

  it("never fetches for a guest share, even on the Record stage", async () => {
    useDawStore.setState({ stage: "record" });
    render(<DawApp guestShare />);
    await act(async () => undefined);
    expect(loadHostRecordState).not.toHaveBeenCalled();
  });

  it("hands StageHost the bootstrap retry for the loading skeleton's Retry", async () => {
    stageHost.props.length = 0;
    render(<DawApp guestShare />);
    await act(async () => undefined);
    const last = stageHost.props.at(-1);
    expect(last?.onRetryLoad).toBe(retryBootstrap);
  });
});
