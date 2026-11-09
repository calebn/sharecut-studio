import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject } from "../../test/fixtures";
import type { TranscriptWordView } from "../../types/project";
import { WordFacts } from "./WordParts";

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

describe("WordFacts hallucination line", () => {
  beforeEach(() => {
    useDawStore.setState({ projectPath: "/tmp/ep", selection: null });
  });

  it("shows the visible explanation for a flagged word", async () => {
    useDawStore.setState({
      project: projectWith({ suspect_hallucination: true }),
    });
    const { container } = render(
      <WordFacts trackId="host" sourceId={null} wordIndex={0} />,
    );
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
    render(<WordFacts trackId="host" sourceId={null} wordIndex={0} />);
    expect(screen.queryByText(TIP)).not.toBeInTheDocument();
  });
});
