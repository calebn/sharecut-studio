import { render } from "@testing-library/react";
import { forwardRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type {
  ScriptPaneProps,
  ScriptPaneReadingPosition,
} from "../../system/ScriptPane";
import { SCRIPT_TURNS } from "../../system/scriptFixtures";
import { GuestScript } from "./GuestScript";
import { WORD_STARTS } from "./guestFixture";
import { useGuestReading } from "./useGuestReading";

const pane = vi.hoisted(() => ({
  props: null as null | { readingPosition?: unknown },
}));
vi.mock("../../system/ScriptPane", () => ({
  ScriptPane: forwardRef((props: { readingPosition?: unknown }, _ref) => {
    pane.props = props;
    return null;
  }),
}));

type Binding = NonNullable<ScriptPaneProps["readingPosition"]>;
const binding = () => pane.props?.readingPosition as Binding;
const place = (index: number): ScriptPaneReadingPosition => ({
  kind: "word",
  index,
  offset: 10,
  fallbackTop: 0,
});

function Harness({ refreshing }: { refreshing: boolean }) {
  const reading = useGuestReading();
  return (
    <GuestScript
      guest="suggester"
      layout="desktop"
      turns={SCRIPT_TURNS}
      wordStarts={WORD_STARTS}
      playing={2}
      refreshing={refreshing}
      reading={reading}
      onSeek={vi.fn()}
    />
  );
}

describe("a follower's bookmark", () => {
  it("is gone when a refresh ends, so the next hold restores the new place", () => {
    const view = render(<Harness refreshing={false} />);
    expect(binding().restore).toBe(false);

    view.rerender(<Harness refreshing />);
    expect(binding().restore).toBe(true);
    expect(binding().getPosition()).toBeNull();
    binding().capture(place(3));
    expect(binding().getPosition()).toMatchObject({ index: 3 });

    view.rerender(<Harness refreshing={false} />);
    expect(binding().restore).toBe(false);
    expect(binding().getPosition()).toBeNull();

    view.rerender(<Harness refreshing />);
    expect(binding().getPosition()).toBeNull();
    binding().capture(place(9));
    expect(binding().getPosition()).toMatchObject({ index: 9 });
  });
});
