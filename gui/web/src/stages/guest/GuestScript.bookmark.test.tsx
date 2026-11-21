import { render } from "@testing-library/react";
import { forwardRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { guestScriptOf } from "../../stage/hosts/guestScript";
import type {
  ScriptPaneProps,
  ScriptPaneReadingPosition,
} from "../../system/ScriptPane";
import { GuestScript } from "./GuestScript";
import { GUEST_SCRIPT } from "./guestFixture";
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
      script={GUEST_SCRIPT}
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

it("publishes the sampled model's word when the follower enters a changed row of bars", () => {
  const word = (text: string, start: number, word_index: number) => ({
    text,
    start,
    end: start + 0.3,
    timeline_start: start,
    timeline_end: start + 0.3,
    word_index,
  });
  const row = {
    track_id: "reference",
    source_id: null,
    speaker: "reader",
    text: "my ghost",
    start: 2.38,
    end: 9,
    words: [word("my", 2.38, 0), word("ghost", 8.49, 1)],
  };
  const before = guestScriptOf([{ kind: "live", utterance: row }]);
  const changed = { ...row, start: 6.48, words: [word("ghost", 8.49, 0)] };
  const bars = guestScriptOf([{ kind: "waiting", utterance: changed }]);
  const live = guestScriptOf([{ kind: "live", utterance: changed }]);
  const show = (script: typeof before, refreshing: boolean) => (
    <GuestScript
      script={script}
      layout="desktop"
      playing={undefined}
      refreshing={refreshing}
      onSeek={vi.fn()}
    />
  );
  const view = render(show(before, false));
  const publish = binding().capture;
  view.rerender(show(bars, true));
  publish({
    kind: "word",
    index: 1,
    offset: -23.859375,
    fallbackTop: 150,
    turns: before.turns,
  });
  expect(binding().getPosition()).toEqual({ kind: "wait" });
  const held = guestScriptOf([{ kind: "held", utterance: changed, lead: 0 }]);
  view.rerender(show(held, true));
  expect(binding().getPosition()).toEqual({ kind: "wait" });
  view.rerender(show(live, true));
  expect(binding().getPosition()).toMatchObject({
    kind: "word",
    index: 0,
    offset: -23.859375,
    turns: live.turns,
  });
});
