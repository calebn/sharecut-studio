import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { act, fireEvent, render, renderHook } from "@testing-library/react";
import {
  StrictMode,
  Suspense,
  startTransition,
  useLayoutEffect,
  useState,
} from "react";
import { describe, expect, it, vi } from "vitest";
import { sourceFiles } from "../test/sourceFiles";
import {
  findStableCallbackRenderCalls,
  type SourceInput,
} from "../test/stableCallbackGovernance";
import { useStableCallback } from "./useStableCallback";

function stableDeclarationMutations(
  source: SourceInput,
): Array<{ source: SourceInput; callback: string; line: number }> {
  if (!source.text.includes("useStableCallback")) return [];
  const ast = parse(source.text, {
    sourceType: "unambiguous",
    plugins: ["typescript", "jsx"],
  });
  const mutations: Array<{
    source: SourceInput;
    callback: string;
    line: number;
  }> = [];
  traverse(ast, {
    VariableDeclarator(path) {
      const { id, init } = path.node;
      const end = path.parentPath.node.end;
      if (
        t.isIdentifier(id) &&
        t.isCallExpression(init) &&
        t.isIdentifier(init.callee, { name: "useStableCallback" }) &&
        path.parentPath.isVariableDeclaration() &&
        end != null
      ) {
        const prefix = source.text.slice(0, end);
        mutations.push({
          source: {
            rel: source.rel,
            text: `${prefix}\n    ${id.name}();${source.text.slice(end)}`,
          },
          callback: id.name,
          line: prefix.split("\n").length + 1,
        });
      }
    },
  });
  return mutations;
}

describe("useStableCallback", () => {
  it("keeps one identity across renders", () => {
    const { result, rerender } = renderHook(
      ({ n }) => useStableCallback(() => n),
      { initialProps: { n: 1 } },
    );
    const first = result.current;
    rerender({ n: 2 });
    expect(result.current).toBe(first);
  });

  it("calls the latest function with its arguments", () => {
    const a = vi.fn((x: number) => x + 1);
    const b = vi.fn((x: number) => x + 2);
    const { result, rerender } = renderHook(({ fn }) => useStableCallback(fn), {
      initialProps: { fn: a },
    });
    rerender({ fn: b });
    expect(result.current(1)).toBe(3);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith(1);
  });

  it("is current in a child's layout effect of the same commit", () => {
    const seen: string[] = [];
    function Child({ onMount }: { onMount: () => void }) {
      useLayoutEffect(() => {
        onMount();
      });
      return null;
    }
    function Parent({ label }: { label: string }) {
      const cb = useStableCallback(() => seen.push(label));
      return <Child onMount={cb} />;
    }
    const { rerender } = render(<Parent label="a" />);
    rerender(<Parent label="b" />);
    expect(seen).toEqual(["a", "b"]);
  });

  it("keeps the committed callback current in StrictMode child layout effects", () => {
    const seen: string[] = [];
    function Child({ onCommit }: { onCommit: () => void }) {
      useLayoutEffect(() => {
        onCommit();
      });
      return null;
    }
    function Parent({ value }: { value: string }) {
      const callback = useStableCallback(() => seen.push(value));
      return <Child onCommit={callback} />;
    }

    const { rerender } = render(
      <StrictMode>
        <Parent value="first" />
      </StrictMode>,
    );
    expect(seen.at(-1)).toBe("first");
    rerender(
      <StrictMode>
        <Parent value="committed" />
      </StrictMode>,
    );
    expect(seen.at(-1)).toBe("committed");
  });

  it("keeps the last committed callback callable after a same-state update", () => {
    const seen: Array<{ value: number; generation: number }> = [];
    const committed: number[] = [];
    let renders = 0;
    function Probe() {
      const [value, setValue] = useState(0);
      const generation = ++renders;
      const callback = useStableCallback(() => ({ value, generation }));
      useLayoutEffect(() => {
        committed.push(generation);
      });
      return (
        <>
          <button onClick={() => setValue(1)} type="button">
            update
          </button>
          <button
            onClick={() => {
              seen.push(callback());
            }}
            type="button"
          >
            read
          </button>
        </>
      );
    }

    const { getByRole } = render(<Probe />);
    fireEvent.click(getByRole("button", { name: "update" }));
    const committedGeneration = committed.at(-1);
    const rendersBeforeBailout = renders;
    fireEvent.click(getByRole("button", { name: "update" }));
    expect(renders).toBeGreaterThan(rendersBeforeBailout);
    expect(committed).toEqual([1, committedGeneration]);
    fireEvent.click(getByRole("button", { name: "read" }));
    expect(seen).toEqual([{ value: 1, generation: committedGeneration }]);
  });

  it("retains the committed callback during a suspended transition and updates it on commit", async () => {
    const attempts: Array<{ value: number; callback: () => number }> = [];
    const commits: Array<{ value: number; callback: () => number }> = [];
    const seen: number[] = [];
    let ready = false;
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    function Probe({ value }: { value: number }) {
      const callback = useStableCallback(() => value);
      attempts.push({ value, callback });
      useLayoutEffect(() => {
        commits.push({ value, callback });
      });
      if (value === 1 && !ready) throw pending;
      return (
        <button type="button" onClick={() => seen.push(callback())}>
          read {value}
        </button>
      );
    }
    function Parent() {
      const [value, setValue] = useState(0);
      return (
        <>
          <button
            type="button"
            onClick={() => startTransition(() => setValue(1))}
          >
            update
          </button>
          <Suspense fallback={<p>loading</p>}>
            <Probe value={value} />
          </Suspense>
        </>
      );
    }
    const { getByRole, queryByText } = render(<Parent />);
    const initial = commits[0]?.callback;
    expect(initial?.()).toBe(0);
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "update" }));
    });
    expect(attempts.some(({ value }) => value === 1)).toBe(true);
    expect(attempts.every(({ callback }) => callback === initial)).toBe(true);
    expect(commits.map(({ value }) => value)).toEqual([0]);
    expect(queryByText("loading")).toBeNull();
    fireEvent.click(getByRole("button", { name: "read 0" }));
    expect(seen).toEqual([0]);
    expect(initial?.()).toBe(0);
    await act(async () => {
      ready = true;
      release?.();
      await pending;
    });
    expect(commits.map(({ value }) => value)).toEqual([0, 1]);
    expect(commits[1]?.callback).toBe(initial);
    fireEvent.click(getByRole("button", { name: "read 1" }));
    expect(seen).toEqual([0, 1]);
    expect(initial?.()).toBe(1);
  });
});

describe("stable callback source governance", () => {
  it.each([
    {
      name: "owner evaluation",
      text: `import { useStableCallback as stable } from "./useStableCallback";\nfunction Probe() {\n  const read = stable(() => 1);\n  return read();\n}`,
      expected: [
        { file: "utils/Fixture.tsx", line: 4, column: 10, callback: "read" },
      ],
    },
    {
      name: "eager JSX argument",
      text: `import { useStableCallback } from "./useStableCallback";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  return <Child value={read()} />;\n}`,
      expected: [
        { file: "utils/Fixture.tsx", line: 4, column: 24, callback: "read" },
      ],
    },
    {
      name: "optional call and call/apply",
      text: `import * as stable from "./useStableCallback";\nfunction Probe() {\n  const read = stable.useStableCallback(() => 1);\n  read?.();\n  read.call(null);\n  read.apply(null, []);\n  read["call"](null);\n  return null;\n}`,
      expected: [
        { file: "utils/Fixture.tsx", line: 4, column: 3, callback: "read" },
        { file: "utils/Fixture.tsx", line: 5, column: 3, callback: "read" },
        { file: "utils/Fixture.tsx", line: 6, column: 3, callback: "read" },
        { file: "utils/Fixture.tsx", line: 7, column: 3, callback: "read" },
      ],
    },
    {
      name: "immediately invoked function",
      text: `import { useStableCallback } from "./useStableCallback";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  (() => read())();\n  return null;\n}`,
      expected: [
        { file: "utils/Fixture.tsx", line: 4, column: 10, callback: "read" },
      ],
    },
    {
      name: "React useMemo alias and lazy initializers",
      text: `import { useStableCallback } from "./useStableCallback";\nimport { useMemo as memo, useState as state, useReducer as reducer } from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  memo(() => read(), []);\n  state(() => read());\n  reducer((x) => x, 0, () => read());\n  return null;\n}`,
      expected: [
        { file: "utils/Fixture.tsx", line: 5, column: 14, callback: "read" },
        { file: "utils/Fixture.tsx", line: 6, column: 15, callback: "read" },
        { file: "utils/Fixture.tsx", line: 7, column: 30, callback: "read" },
      ],
    },
    {
      name: "passing a stable callback to an eager initializer",
      text: `import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  React.useMemo(read, []);\n  return null;\n}`,
      expected: [
        { file: "utils/Fixture.tsx", line: 5, column: 17, callback: "read" },
      ],
    },
  ])("reports exact diagnostic values for $name", ({ text, expected }) => {
    expect(
      findStableCallbackRenderCalls({ rel: "utils/Fixture.tsx", text }),
    ).toEqual(expected);
  });

  it("accepts deferred callbacks and lexical shadows", () => {
    const source: SourceInput = {
      rel: "utils/Fixture.tsx",
      text: `import { useStableCallback } from "./useStableCallback";\nimport { useEffect } from "react";\nfunction Probe({ Child, observer }) {\n  const read = useStableCallback(() => 1);\n  useEffect(() => read(), [read]);\n  observer.observe(read);\n  const child = <Child onClick={() => read()} value={read} />;\n  { const read = () => 2; read(); }\n  try { throw () => 2; } catch (read) { read(); }\n  for (let read = () => 2; false; ) { read(); }\n  switch (0) { case 0: let read = () => 2; read(); }\n  ((read) => read())(() => 3);\n  return child;\n}`,
    };
    expect(findStableCallbackRenderCalls(source)).toEqual([]);
  });

  it("fails when a source file cannot be parsed", () => {
    expect(() =>
      findStableCallbackRenderCalls({
        rel: "utils/Invalid.tsx",
        text: "function Probe( {",
      }),
    ).toThrow();
  });

  it("rejects every current stable callback declaration after an in-memory mutation", () => {
    const owners = [...sourceFiles()].filter(
      ({ rel }) =>
        !rel.includes(".test.") &&
        !rel.startsWith("test/") &&
        !rel.includes(".stories."),
    );
    const mutations = owners.flatMap(stableDeclarationMutations);
    expect(
      mutations
        .map(({ source, callback }) => `${source.rel}:${callback}`)
        .sort(),
    ).toEqual([
      "timeline/JoinEditor.tsx:place",
      "timeline/JoinPopover.tsx:place",
      "timeline/TimelineView.tsx:measure",
      "timeline/TimelineView.tsx:onClipBodyEnd",
      "timeline/TimelineView.tsx:onClipBodyStart",
      "timeline/TimelineView.tsx:onClipMoveCancel",
      "timeline/TimelineView.tsx:onClipMoveCommit",
      "timeline/TimelineView.tsx:onClipMovePreview",
      "timeline/TimelineView.tsx:onSeek",
      "timeline/TimelineView.tsx:onSelectClip",
      "timeline/TimelineView.tsx:onSelectPending",
      "timeline/TimelineView.tsx:onSelectTrack",
    ]);
    for (const mutation of mutations) {
      expect(findStableCallbackRenderCalls(mutation.source)).toEqual([
        {
          file: mutation.source.rel,
          line: mutation.line,
          column: 5,
          callback: mutation.callback,
        },
      ]);
    }
  });

  it("automatically scans all production source files and excludes tests and support", () => {
    for (const source of sourceFiles()) {
      if (
        source.rel.includes(".test.") ||
        source.rel.startsWith("test/") ||
        source.rel.includes(".stories.")
      ) {
        continue;
      }
      expect(findStableCallbackRenderCalls(source), source.rel).toEqual([]);
    }
  });
});
