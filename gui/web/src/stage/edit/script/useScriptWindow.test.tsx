import { act, render } from "@testing-library/react";
import {
  createRef,
  forwardRef,
  Suspense,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { describe, expect, it, vi } from "vitest";
import type { ScriptPaneHandle } from "../../../system/ScriptPane";
import type { ScriptTurn } from "../../../system/scriptPieces";
import { scriptUtterance, scriptWord } from "../../../test/scriptHostKit";
import { buildScriptModel, type ScriptModel } from "./scriptModel";
import {
  type ScriptWindow,
  useScriptWindow,
  WINDOW_LIMIT,
} from "./useScriptWindow";

type Focus = Parameters<typeof useScriptWindow>[3];
const WAIT = new Promise<void>(() => {});

type Call = { index: number; block?: ScrollLogicalPosition; visible: boolean };
const INACTIVE = {
  playKey: "idle",
  playing: [] as readonly number[],
  playheadWord: undefined,
  following: false,
};

function modelOf(count = 400): ScriptModel {
  return buildScriptModel({
    utterances: Array.from({ length: count }, (_, index) =>
      scriptUtterance(
        index % 2 ? "guest" : "host",
        index % 2 ? "Jon" : "Maya",
        [scriptWord(`word${index}`, index, index)],
      ),
    ),
    boundaries: [],
    pending: [],
    person: (track, name) => ({ name, colorIndex: track === "host" ? 0 : 1 }),
  });
}

const Pane = forwardRef<
  ScriptPaneHandle,
  {
    turns: readonly ScriptTurn[];
    calls: Call[];
    afterCommit: () => void;
    onVisibleScroll?: (text: string) => void;
  }
>(({ turns, calls, afterCommit, onVisibleScroll }, ref) => {
  useImperativeHandle(
    ref,
    () => ({
      scrollToWord: (index, block) => {
        const word = turns
          .flatMap((turn) => turn.words)
          .find((word) => word.index === index);
        const visible = word !== undefined;
        calls.push({ index, block, visible });
        if (word) onVisibleScroll?.(word.text);
        return visible;
      },
      focusFind: () => false,
      focusWord: () => false,
    }),
    [turns, calls, onVisibleScroll],
  );
  useLayoutEffect(() => {
    afterCommit();
  });
  return (
    <div className="sys-script-body">
      {turns.map((turn) => (
        <p key={turn.id} data-turn-id={turn.id}>
          {turn.words.map((word) => (
            <span key={word.index} data-window-word={word.index}>
              {word.text}
            </span>
          ))}
        </p>
      ))}
    </div>
  );
});

const Harness = forwardRef<
  ScriptWindow,
  {
    model: ScriptModel;
    calls: Call[];
    afterChildCommit?: (window: ScriptWindow) => void;
    onVisibleScroll?: (text: string) => void;
    focus?: Focus;
    suspend?: boolean;
  }
>(
  (
    {
      model,
      calls,
      afterChildCommit,
      onVisibleScroll,
      focus = INACTIVE,
      suspend = false,
    },
    ref,
  ) => {
    const pane = useRef<ScriptPaneHandle>(null);
    const host = useRef<HTMLDivElement>(null);
    const window = useScriptWindow(model, pane, host, focus);
    useImperativeHandle(ref, () => window, [window]);
    if (suspend) throw WAIT;
    return (
      <div ref={host}>
        <Pane
          ref={pane}
          turns={window.turns}
          calls={calls}
          onVisibleScroll={onVisibleScroll}
          afterCommit={() => afterChildCommit?.(window)}
        />
      </div>
    );
  },
);

function indices(window: ScriptWindow): number[] {
  return window.turns.flatMap((turn) => turn.words.map((word) => word.index));
}

describe("useScriptWindow accepted requests", () => {
  it.each([
    { count: 0, drawn: 0 },
    { count: 150, drawn: 150 },
    { count: 151, drawn: 41 },
  ])("draws $drawn turns at the $count-turn boundary", ({ count, drawn }) => {
    const window = createRef<ScriptWindow>();
    render(<Harness ref={window} model={modelOf(count)} calls={[]} />);
    expect(window.current!.turns).toHaveLength(drawn);
  });

  it("composes two edge requests before a render while preserving the cap", () => {
    const window = createRef<ScriptWindow>();
    render(<Harness ref={window} model={modelOf()} calls={[]} />);
    act(() => {
      window.current!.reached(40);
      window.current!.reached(80);
    });
    expect(indices(window.current!)).toEqual(
      Array.from({ length: 121 }, (_, index) => index),
    );
    expect(window.current!.turns.length).toBeLessThanOrEqual(WINDOW_LIMIT);
  });

  it("draws and retries only the last of two far jumps before a render", () => {
    const window = createRef<ScriptWindow>();
    const calls: Call[] = [];
    render(<Harness ref={window} model={modelOf()} calls={calls} />);
    act(() => {
      expect(window.current!.scrollTo(180, "center")).toBe(false);
      expect(window.current!.scrollTo(330, "nearest")).toBe(false);
    });
    expect(indices(window.current!)).toContain(330);
    expect(indices(window.current!)).not.toContain(180);
    expect(calls.filter((call) => call.visible)).toEqual([
      { index: 330, block: "nearest", visible: true },
    ]);
    act(() => window.current!.reached(370));
    expect(calls.filter((call) => call.visible)).toHaveLength(1);
    expect(window.current!.turns.length).toBeLessThanOrEqual(WINDOW_LIMIT);
  });

  it.each([0, 180])(
    "a superseding scroll to %s clears the previous pending jump",
    (index) => {
      const window = createRef<ScriptWindow>();
      const calls: Call[] = [];
      render(<Harness ref={window} model={modelOf()} calls={calls} />);
      act(() => {
        window.current!.scrollTo(180);
        window.current!.scrollTo(index);
      });
      expect(
        calls.filter((call) => call.visible && call.index === 180),
      ).toHaveLength(0);
      act(() => window.current!.reached(220));
      expect(
        calls.filter((call) => call.visible && call.index === 180),
      ).toHaveLength(0);
    },
  );

  it("leaves a newer child-layout jump pending until its own words are drawn", () => {
    const window = createRef<ScriptWindow>();
    const calls: Call[] = [];
    let requested = false;
    render(
      <Harness
        ref={window}
        model={modelOf()}
        calls={calls}
        afterChildCommit={(current) => {
          if (!requested && indices(current).includes(180)) {
            requested = true;
            current.scrollTo(330, "nearest");
          }
        }}
      />,
    );
    act(() => {
      window.current!.scrollTo(180, "center");
    });
    expect(requested).toBe(true);
    expect(indices(window.current!)).toContain(330);
    expect(calls.filter((call) => call.index === 330 && call.visible)).toEqual([
      { index: 330, block: "nearest", visible: true },
    ]);
  });

  it("composes from the shortened model's resolved window before parent layout", () => {
    const window = createRef<ScriptWindow>();
    const calls: Call[] = [];
    const full = modelOf();
    const shorter = modelOf(240);
    let grow = false;
    const onCommit = (current: ScriptWindow) => {
      if (grow && indices(current).at(-1) === 40) {
        grow = false;
        current.reached(40);
      }
    };
    const { rerender } = render(
      <Harness
        ref={window}
        model={full}
        calls={calls}
        afterChildCommit={onCommit}
      />,
    );
    act(() => {
      window.current!.scrollTo(330);
    });
    grow = true;
    rerender(
      <Harness
        ref={window}
        model={shorter}
        calls={calls}
        afterChildCommit={onCommit}
      />,
    );
    expect(grow).toBe(false);
    expect(indices(window.current!)).toEqual(
      Array.from({ length: 81 }, (_, index) => index),
    );
  });
  it("retains a pending jump when a later edge request widens its window", () => {
    const window = createRef<ScriptWindow>();
    const calls: Call[] = [];
    render(<Harness ref={window} model={modelOf()} calls={calls} />);
    act(() => {
      window.current!.scrollTo(180, "center");
      window.current!.reached(220);
    });
    expect(indices(window.current!)).toContain(260);
    expect(calls.filter((call) => call.visible)).toEqual([
      { index: 180, block: "center", visible: true },
    ]);
  });

  it("retries a new child request when it returns to previously drawn coordinates", () => {
    const window = createRef<ScriptWindow>();
    const calls: Call[] = [];
    let returnToPrevious = false;
    render(
      <Harness
        ref={window}
        model={modelOf()}
        calls={calls}
        afterChildCommit={(current) => {
          if (returnToPrevious && indices(current).includes(180)) {
            returnToPrevious = false;
            current.scrollTo(330, "nearest");
          }
        }}
      />,
    );
    act(() => {
      window.current!.scrollTo(330);
    });
    calls.length = 0;
    returnToPrevious = true;
    act(() => {
      window.current!.scrollTo(180, "center");
    });
    expect(returnToPrevious).toBe(false);
    expect(indices(window.current!)).toContain(330);
    expect(calls.filter((call) => call.visible)).toEqual([
      { index: 330, block: "nearest", visible: true },
    ]);
  });
  it("keeps a compatible same-path model rebuild's pending target", () => {
    const window = createRef<ScriptWindow>();
    const calls: Call[] = [];
    const seen: string[] = [];
    const before = modelOf();
    const after = modelOf();
    const { rerender } = render(
      <Harness
        ref={window}
        model={before}
        calls={calls}
        onVisibleScroll={(text) => {
          seen.push(`before:${text}`);
        }}
      />,
    );
    act(() => {
      window.current!.scrollTo(180, "center");
      rerender(
        <Harness
          ref={window}
          model={after}
          calls={calls}
          onVisibleScroll={(text) => {
            seen.push(`after:${text}`);
          }}
        />,
      );
    });
    expect(after).not.toBe(before);
    expect(indices(window.current!)).toContain(180);
    expect(seen).toEqual(["after:word180"]);
    expect(calls.filter((call) => call.visible)).toHaveLength(1);
  });

  it("applies the latest child-layout eye mark after that request is drawn", () => {
    const rect = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        if (this.classList.contains("sys-script-body"))
          return new DOMRect(0, 0, 100, 200);
        if (this.matches("p[data-turn-id]")) {
          const body = this.parentElement!;
          const row = Array.from(body.children).indexOf(this);
          return new DOMRect(0, row * 20 - body.scrollTop, 100, 20);
        }
        return new DOMRect();
      });
    const window = createRef<ScriptWindow>();
    let next = false;
    let offset: number | undefined;
    try {
      render(
        <Harness
          ref={window}
          model={modelOf()}
          calls={[]}
          afterChildCommit={(current) => {
            if (next && indices(current).at(-1) === 300) {
              next = false;
              const body =
                document.querySelector<HTMLElement>(".sys-script-body")!;
              body.scrollTop = 1400;
              const mark = body.querySelector('[data-window-word="221"]')!
                .parentElement!;
              offset =
                mark.getBoundingClientRect().top -
                body.getBoundingClientRect().top;
              current.reached(300);
            }
          }}
        />,
      );
      act(() => {
        window.current!.scrollTo(180);
      });
      act(() => {
        window.current!.reached(220);
      });
      const body = document.querySelector<HTMLElement>(".sys-script-body")!;
      body.scrollTop = 1200;
      next = true;
      act(() => {
        window.current!.reached(260);
      });
      expect(next).toBe(false);
      expect(offset).toBe(0);
      const mark = body.querySelector('[data-window-word="221"]')!
        .parentElement!;
      expect(
        mark.getBoundingClientRect().top - body.getBoundingClientRect().top,
      ).toBe(offset);
      expect(body.scrollTop).toBe(600);
    } finally {
      rect.mockRestore();
    }
  });

  it("retains the last committed anchor after a suspended followed-word render", () => {
    const window = createRef<ScriptWindow>();
    const model = modelOf();
    const calls: Call[] = [];
    const following = (index: number): Focus => ({
      following: true,
      playing: [index],
      playheadWord: index,
      playKey: `word:${index}`,
    });
    const { rerender } = render(
      <Suspense fallback={<p>Waiting</p>}>
        <Harness
          ref={window}
          model={model}
          calls={calls}
          focus={following(100)}
        />
      </Suspense>,
    );
    rerender(
      <Suspense fallback={<p>Waiting</p>}>
        <Harness
          ref={window}
          model={model}
          calls={calls}
          focus={following(300)}
          suspend
        />
      </Suspense>,
    );
    rerender(
      <Suspense fallback={<p>Waiting</p>}>
        <Harness ref={window} model={model} calls={calls} focus={INACTIVE} />
      </Suspense>,
    );
    expect(indices(window.current!)).toContain(100);
    expect(indices(window.current!)).not.toContain(300);
  });
});
