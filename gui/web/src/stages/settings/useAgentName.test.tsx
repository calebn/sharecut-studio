import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { useAgentName } from "./useAgentName";

beforeEach(() => {
  useDawStore.getState().setSessionClients([], 1);
});

describe("useAgentName", () => {
  it("is null until an agent is in the room", () => {
    const { result } = renderHook(() => useAgentName());
    expect(result.current).toBeNull();
    act(() =>
      useDawStore
        .getState()
        .setSessionClients([{ client_id: "v1", role: "viewer" }], 2),
    );
    expect(result.current).toBeNull();
  });

  it("names the agent that joined", () => {
    const { result } = renderHook(() => useAgentName());
    act(() =>
      useDawStore.getState().setSessionClients(
        [
          { client_id: "v1", role: "viewer" },
          { client_id: "a1", role: "agent", label: "Claude" },
        ],
        3,
      ),
    );
    expect(result.current).toBe("Claude");
  });

  it("calls an unlabelled agent Agent", () => {
    const { result } = renderHook(() => useAgentName());
    act(() =>
      useDawStore
        .getState()
        .setSessionClients([{ client_id: "a1", role: "agent" }], 4),
    );
    expect(result.current).toBe("Agent");
  });
});
