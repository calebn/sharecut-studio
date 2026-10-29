import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DeviceSheet } from "../system/DeviceSheet";
import { deviceMic } from "./deviceSheet";
import type { MicPermissionStatus } from "./micPermission";
import { useInputSwitching } from "./useInputSwitching";

const devices = [
  { deviceId: "a", label: "USB Mic" },
  { deviceId: "b", label: "Headset" },
] as MediaDeviceInfo[];

const streamA = {} as MediaStream;
const streamB = {} as MediaStream;

function Harness({
  stream,
  status,
  deviceId,
  onPick,
}: {
  stream: MediaStream | null;
  status: MicPermissionStatus;
  deviceId: string;
  onPick: (id: string) => void;
}) {
  const switching = useInputSwitching(stream, status, deviceId);
  return (
    <DeviceSheet
      mic={deviceMic(
        { status, stream, devices },
        { deviceId, levelDb: -60, switching },
      )}
      tone={{ state: "idle", label: "Record room tone" }}
      onInputChange={onPick}
      onRecordRoomTone={() => {}}
      onClose={() => {}}
    />
  );
}

describe("useInputSwitching", () => {
  it("keeps the Input menu mounted and focused across an input change", async () => {
    const picks: string[] = [];
    const props = { onPick: (id: string) => picks.push(id) };
    const { rerender } = render(
      <Harness stream={streamA} status="granted" deviceId="a" {...props} />,
    );
    const select = screen.getByLabelText("Input");
    await userEvent.selectOptions(select, "b");
    expect(picks).toEqual(["b"]);
    expect(select).toHaveFocus();

    rerender(
      <Harness stream={streamA} status="granted" deviceId="b" {...props} />,
    );
    rerender(
      <Harness stream={null} status="prompting" deviceId="b" {...props} />,
    );
    expect(screen.getByLabelText("Input")).toBe(select);
    expect(select).toHaveFocus();
    expect(select).toBeEnabled();
    expect(select).toHaveValue("b");
    expect(screen.queryByText("Waiting for your browser…")).toBeNull();

    rerender(
      <Harness stream={streamB} status="granted" deviceId="b" {...props} />,
    );
    expect(screen.getByLabelText("Input")).toBe(select);
    expect(select).toHaveFocus();
  });

  it("does not hide a real prompt or failure", () => {
    const props = { onPick: () => {} };
    const { rerender } = render(
      <Harness stream={streamA} status="granted" deviceId="a" {...props} />,
    );
    rerender(<Harness stream={null} status="denied" deviceId="b" {...props} />);
    expect(screen.queryByLabelText("Input")).toBeNull();
    rerender(
      <Harness stream={null} status="prompting" deviceId="b" {...props} />,
    );
    expect(screen.queryByLabelText("Input")).toBeNull();
  });

  it("is not switching before any stream or after the mic is turned off", () => {
    const props = { onPick: () => {} };
    const { rerender } = render(
      <Harness stream={null} status="prompting" deviceId="b" {...props} />,
    );
    expect(screen.queryByLabelText("Input")).toBeNull();
    rerender(
      <Harness stream={streamA} status="granted" deviceId="b" {...props} />,
    );
    rerender(<Harness stream={null} status="idle" deviceId="b" {...props} />);
    expect(screen.queryByLabelText("Input")).toBeNull();
  });
});
