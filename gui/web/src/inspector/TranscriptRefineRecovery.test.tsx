import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TRANSCRIPT_REFINE_REQUIRED_CODE } from "../utils/apiError";
import { waiveTranscriptRefine } from "../api";
import {
  TranscriptRefineRecovery,
  WAIVER_REASON_MAX,
} from "./TranscriptRefineRecovery";

vi.mock("../api", () => ({ waiveTranscriptRefine: vi.fn() }));

const props = {
  projectPath: "/tmp/p.json",
  error: "blocked",
  onRecovered: () => {},
};

describe("TranscriptRefineRecovery", () => {
  afterEach(() => {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  });

  it("scrolls its form into view when the gate refuses, and not for other errors", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { rerender } = render(
      <TranscriptRefineRecovery {...props} errorCode="document_conflict" />,
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
    rerender(
      <TranscriptRefineRecovery
        {...props}
        errorCode={TRANSCRIPT_REFINE_REQUIRED_CODE}
      />,
    );
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("counts the reason against the server cap and stops typing at it", () => {
    render(
      <TranscriptRefineRecovery
        {...props}
        errorCode={TRANSCRIPT_REFINE_REQUIRED_CODE}
      />,
    );
    const box = screen.getByRole("textbox", { name: /Waiver reason/ });
    expect(box).toHaveAttribute("maxlength", String(WAIVER_REASON_MAX));
    expect(
      screen.getByText(new RegExp(`0 of ${WAIVER_REASON_MAX} characters`)),
    ).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "Checked by ear" } });
    expect(
      screen.getByText(new RegExp(`14 of ${WAIVER_REASON_MAX} characters`)),
    ).toBeInTheDocument();
  });

  it("shows the server's plain message when the waiver is refused", async () => {
    vi.mocked(waiveTranscriptRefine).mockRejectedValueOnce(
      new Error("reason must be at most 2000 characters"),
    );
    render(
      <TranscriptRefineRecovery
        {...props}
        errorCode={TRANSCRIPT_REFINE_REQUIRED_CODE}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: /Waiver reason/ }), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Waive with reason" }));
    await waitFor(() =>
      expect(
        screen.getByText("reason must be at most 2000 characters"),
      ).toBeInTheDocument(),
    );
  });
});
