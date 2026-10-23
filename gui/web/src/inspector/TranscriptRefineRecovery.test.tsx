import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TRANSCRIPT_REFINE_REQUIRED_CODE } from "../utils/apiError";
import { TranscriptRefineRecovery } from "./TranscriptRefineRecovery";

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
});
