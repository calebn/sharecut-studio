import { act, render } from "@testing-library/react";
import {
  type RefObject,
  Suspense,
  startTransition,
  useRef,
  useState,
} from "react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  scriptUtterance,
  scriptWord,
  seedScript,
} from "../../../test/scriptHostKit";
import type { CombinedUtterance } from "../../../types/project";
import { useScriptModel } from "./useScriptModel";
import { useScriptWindow } from "./useScriptWindow";

function longTranscript(turns: number): CombinedUtterance[] {
  return Array.from({ length: turns }, (_, n) => {
    const track = n % 2 === 0 ? "host" : "guest";
    return scriptUtterance(track, track === "host" ? "Maya" : "Anneke", [
      scriptWord(`a${n}`, n * 2, n * 2),
      scriptWord(`b${n}`, n * 2 + 1, n * 2 + 1),
    ]);
  });
}

const never = new Promise<void>(() => {});
const drawn: { turns: string[] } = { turns: [] };
let setLive: (word: number | undefined) => void = () => {};
let setFollowing: (on: boolean) => void = () => {};

function Gate({ blocked }: { blocked: boolean }) {
  if (blocked) throw never;
  return null;
}

function Probe() {
  const { model } = useScriptModel();
  const pane = useRef(null);
  const host = useRef<HTMLElement | null>(null);
  const [live, setLiveState] = useState<number | undefined>(0);
  const [following, setFollowingState] = useState(true);
  const [pending, setPending] = useState(false);
  setLive = (word) =>
    startTransition(() => {
      setLiveState(word);
      setPending(true);
    });
  setFollowing = setFollowingState;
  const win = useScriptWindow(model, pane as RefObject<null>, host, {
    playKey: "",
    playing: [],
    playheadWord: live,
    following,
  });
  drawn.turns = win.turns.map((t) => t.words[0]?.text ?? "");
  return (
    <Suspense fallback={null}>
      <Gate blocked={pending} />
    </Suspense>
  );
}

beforeEach(() => seedScript({ utterances: longTranscript(400) }));

describe("useScriptWindow", () => {
  it("keeps the window on the committed playhead word when React discards a transition render", () => {
    render(<Probe />);
    const first = drawn.turns[0];
    act(() => setLive(780));
    act(() => setFollowing(false));
    expect(first).toBe("a0");
    expect(drawn.turns).toContain("a0");
  });
});
