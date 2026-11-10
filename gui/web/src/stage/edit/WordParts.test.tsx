import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject } from "../../test/fixtures";
import type { TranscriptWordView } from "../../types/project";
import { wordSelection } from "../../utils/rangeSelect";
import { useWordSections } from "./wordSections";

const TIP = "Possible transcription with no matching speech";

function projectWith(extra: Partial<TranscriptWordView>) {
  return minimalProject({
    transcript: {
      utterances: [
        {
          track_id: "host",
          speaker: "Host",
          start: 0,
          end: 1,
          text: "hello",
          mappable: true,
          timeline_start: 0,
          timeline_end: 1,
          words: [
            {
              text: "hello",
              start: 0,
              end: 1,
              timeline_start: 0,
              timeline_end: 1,
              word_index: 0,
              confidence: 0.9,
              ...extra,
            },
          ],
        },
      ],
    },
  });
}

function Sheet() {
  const sections = useWordSections(
    wordSelection({ trackId: "host", sourceId: null, wordIndex: 0 }),
  );
  return (
    <div>
      {sections?.flatMap((section) =>
        section.rows.map((row) => (
          <div key={`${section.id}:${row.id}`}>{row.control}</div>
        )),
      )}
    </div>
  );
}

describe("word sheet hallucination line", () => {
  beforeEach(() => {
    useDawStore.setState({ projectPath: "/tmp/ep", selection: null });
  });

  it("shows the visible explanation for a flagged word", async () => {
    useDawStore.setState({
      project: projectWith({ suspect_hallucination: true }),
    });
    const { container } = render(<Sheet />);
    expect(screen.getByText(TIP)).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it.each([
    ["an unflagged word", {}],
    [
      "a suppressed flagged word",
      { suspect_hallucination: true, suppressed: true },
    ],
    ["an ignored flagged word", { suspect_hallucination: true, ignored: true }],
  ] as const)("shows nothing for %s", (_name, extra) => {
    useDawStore.setState({ project: projectWith(extra) });
    render(<Sheet />);
    expect(screen.queryByText(TIP)).not.toBeInTheDocument();
  });
});
