import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { NEAR_LIMIT_TERMS, SOME_TERMS, SPEAKER_NAMES } from "./prepareFixture";
import { Vocabulary, type VocabularyProps } from "./Vocabulary";

function Held(props: Partial<VocabularyProps>) {
  const [terms, setTerms] = useState<readonly string[]>(props.terms ?? []);
  return (
    <Vocabulary
      speakers={SPEAKER_NAMES}
      {...props}
      terms={terms}
      onTermsChange={(next) => {
        setTerms(next);
        props.onTermsChange?.(next);
      }}
    />
  );
}

describe("Vocabulary", () => {
  it("names the section and leads with the speakers, which cannot be removed", () => {
    render(<Held terms={SOME_TERMS} />);
    expect(
      screen.getByRole("heading", { level: 2, name: "Help the transcriber" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("listitem", { name: "Joss, speaker" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove Joss/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Remove Quetzalcoatlus" }),
    ).toBeInTheDocument();
  });

  it("leaves out its own heading when Prepare draws one", () => {
    render(<Held heading={false} />);
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("shows no count until the limit is near, then says how many are left", () => {
    const { unmount } = render(<Held terms={SOME_TERMS} />);
    expect(screen.queryByText(/ left$/)).toBeNull();
    unmount();
    render(<Held terms={NEAR_LIMIT_TERMS} />);
    expect(screen.getByText("25 left")).toBeInTheDocument();
  });

  it("says plainly when the limit is reached and refuses the term", async () => {
    const user = userEvent.setup();
    const onTermsChange = vi.fn();
    render(<Held terms={NEAR_LIMIT_TERMS} onTermsChange={onTermsChange} />);
    await user.type(
      screen.getByRole("textbox", { name: "Names and terms" }),
      "Another very long term indeed{Enter}",
    );
    expect(
      screen.getAllByText("That is the limit. Remove a term to add more.")
        .length,
    ).toBeGreaterThan(0);
    expect(onTermsChange).not.toHaveBeenCalled();
  });

  it("offers Re-transcribe only after transcription has run", async () => {
    const user = userEvent.setup();
    const onRetranscribe = vi.fn();
    const { rerender } = render(
      <Vocabulary
        speakers={SPEAKER_NAMES}
        terms={[]}
        onTermsChange={vi.fn()}
        onRetranscribe={onRetranscribe}
      />,
    );
    expect(screen.queryByRole("button", { name: "Re-transcribe" })).toBeNull();
    rerender(
      <Vocabulary
        speakers={SPEAKER_NAMES}
        terms={[]}
        onTermsChange={vi.fn()}
        needsRetranscribe
        onRetranscribe={onRetranscribe}
      />,
    );
    expect(
      screen.getByText("Applies next time words are transcribed."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Re-transcribe" }));
    expect(onRetranscribe).toHaveBeenCalledTimes(1);
  });
});
