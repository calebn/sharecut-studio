import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waiveTranscriptRefine } from "../api";
import { TRANSCRIPT_REFINE_REQUIRED_CODE } from "../utils/apiError";
import {
  CUT_ANYWAY_REASON,
  TranscriptRefineRecovery,
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

  it("offers Cut anyway with no text box, and saves the canned reason", async () => {
    vi.mocked(waiveTranscriptRefine).mockResolvedValueOnce({} as never);
    const onRecovered = vi.fn();
    render(
      <TranscriptRefineRecovery
        {...props}
        onRecovered={onRecovered}
        errorCode={TRANSCRIPT_REFINE_REQUIRED_CODE}
      />,
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cut anyway" }));
    await waitFor(() => expect(onRecovered).toHaveBeenCalledOnce());
    expect(waiveTranscriptRefine).toHaveBeenCalledWith(
      "/tmp/p.json",
      CUT_ANYWAY_REASON,
    );
  });

  it("shows the server's plain message when the waiver is refused", async () => {
    vi.mocked(waiveTranscriptRefine).mockRejectedValueOnce(
      new Error("project is read-only"),
    );
    render(
      <TranscriptRefineRecovery
        {...props}
        errorCode={TRANSCRIPT_REFINE_REQUIRED_CODE}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cut anyway" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "project is read-only",
      ),
    );
  });
});
