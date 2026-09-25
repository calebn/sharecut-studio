import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { recordSnapshot } from "../test/fixtures";
import { useRecordHostStore } from "./hostStore";
import { RecordTransportChip } from "./RecordTransportChip";

describe("RecordTransportChip", () => {
  afterEach(() => {
    useRecordHostStore.getState().setSnapshot(null);
    useRecordHostStore.getState().setCaptureHealth(null);
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
});
