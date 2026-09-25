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
});
