import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordSnapshot } from "../test/fixtures";
import { useRecordHostStore } from "./hostStore";
import { RecordTransportChip } from "./RecordTransportChip";

describe("RecordTransportChip", () => {
  beforeEach(() => {
    useRecordHostStore.getState().setConnected(true);
  });

  afterEach(() => {
    useRecordHostStore.getState().resetConnection();
    useRecordHostStore.getState().setSnapshot(null);
    useRecordHostStore.getState().setCaptureHealth(null);
    useRecordHostStore.getState().setTakeClipping(null);
  });

  it("labels silent capture", () => {
    useRecordHostStore.getState().setSnapshot(recordSnapshot());
    useRecordHostStore.getState().setCaptureHealth("silent");
    render(<RecordTransportChip />);
    expect(
      screen.getByRole("button", {
        name: "No audio reaching the recorder. Open record panel",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("REC: no audio")).toBeInTheDocument();
  });

  it("shows a reconnecting label and no dot when the host socket drops", () => {
    useRecordHostStore.getState().setSnapshot(recordSnapshot());
    useRecordHostStore.getState().setConnected(false);
    render(<RecordTransportChip />);
    const chip = screen.getByRole("button", {
      name: "Record room reconnecting. Open record panel",
    });
    expect(chip).toHaveAttribute("data-offline", "true");
    expect(screen.getByText("REC (reconnecting)")).toBeInTheDocument();
    expect(document.querySelector(".record-rec-dot")).toBeNull();
  });

  it("does not claim a reconnect before the host socket first opens", () => {
    useRecordHostStore.getState().resetConnection();
    useRecordHostStore.getState().setSnapshot(recordSnapshot());
    render(<RecordTransportChip />);
    const chip = screen.getByRole("button", {
      name: "Recording. Open record panel",
    });
    expect(chip).not.toHaveAttribute("data-offline");
    expect(screen.queryByText("REC (reconnecting)")).toBeNull();
  });

  it("lets a capture problem outrank the offline label", () => {
    useRecordHostStore.getState().setSnapshot(recordSnapshot());
    useRecordHostStore.getState().setCaptureHealth("failed");
    useRecordHostStore.getState().setConnected(false);
    render(<RecordTransportChip />);
    expect(
      screen.getByRole("button", {
        name: "Local capture failed. Open record panel",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("REC: local capture failed")).toBeInTheDocument();
  });

  it.each([
    ["failed", "Local capture failed. Open record panel"],
    ["pending", "Waiting for microphone. Open record panel"],
    ["silent", "No audio reaching the recorder. Open record panel"],
    [null, "Recording. Open record panel"],
  ] as const)("labels %s capture while recording", (health, name) => {
    useRecordHostStore.getState().setSnapshot(recordSnapshot());
    useRecordHostStore.getState().setCaptureHealth(health);
    render(<RecordTransportChip />);
    expect(screen.getByRole("button", { name })).toBeInTheDocument();
  });

  it("lights the clip LED and prefixes the label once the take clips", () => {
    useRecordHostStore.getState().setSnapshot(recordSnapshot());
    useRecordHostStore.getState().setTakeClipping({
      takeIndex: 0,
      known: true,
      regions: [{ segmentIndex: 0, startMs: 1, endMs: 5, segmentStartMs: 1 }],
    });
    render(<RecordTransportChip />);
    const chip = screen.getByRole("button", {
      name: "Clipping detected. Recording. Open record panel",
    });
    expect(chip.querySelector("[data-testid='clip-led']")).toHaveAttribute(
      "data-lit",
      "true",
    );
  });
});
