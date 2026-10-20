import type { Page, TestInfo } from "@playwright/test";
import { expect, it, vi } from "vitest";
import "./comment-undo.spec";
import "./transcript-wordbar.spec";
import "../e2e-compat/comment-undo.spec";
import "../e2e-compat/transcript-wordbar.spec";

const registrations = vi.hoisted(() => ({
  viewport: undefined as { width: number; height: number } | undefined,
  cases: [] as {
    title: string;
    viewport?: { width: number; height: number };
    run: (fixtures: { page: Page }, info: TestInfo) => Promise<void>;
  }[],
  comment: vi.fn(),
  wordbar: vi.fn(),
}));

vi.mock("@playwright/test", () => {
  const test = Object.assign(
    (
      title: string,
      run: (fixtures: { page: Page }, info: TestInfo) => Promise<void>,
    ) => {
      registrations.cases.push({
        title,
        viewport: registrations.viewport,
        run,
      });
    },
    {
      describe: (_title: string, body: () => void) => {
        const previous = registrations.viewport;
        body();
        registrations.viewport = previous;
      },
      use: ({ viewport }: { viewport: { width: number; height: number } }) => {
        registrations.viewport = viewport;
      },
    },
  );
  return { test };
});
vi.mock("./commentUndo", () => ({
  exerciseCommentUndo: registrations.comment,
}));
vi.mock("./wordbarFlow", () => ({
  checkWordbarOutsideRelease: registrations.wordbar,
}));

async function runCase(title: string) {
  const entry = registrations.cases.find((entry) => entry.title === title);
  expect(entry).toBeDefined();
  let viewport = entry!.viewport;
  const page = {
    setViewportSize: async (value: { width: number; height: number }) => {
      viewport = value;
    },
  } as Page;
  const info = {} as TestInfo;
  await entry!.run({ page }, info);
  return { page, info, viewport };
}

it("retains comment recovery's exact dark phone profile in main", async () => {
  const main = await runCase(
    "keeps Undo reachable and returns focus without scrolling in dark",
  );
  expect(registrations.comment).toHaveBeenLastCalledWith(
    main.page,
    "dark",
    main.info,
  );
  const compat = await runCase(
    "comment recovery keeps native disabled-button focus and sticky controls",
  );
  expect(registrations.comment).toHaveBeenLastCalledWith(
    compat.page,
    "dark",
    compat.info,
  );
  expect(main.viewport).toEqual({ width: 360, height: 800 });
  expect(compat.viewport).toEqual(main.viewport);
});

it("retains the same wordbar helper with inherited profiles in main", async () => {
  const main = await runCase(
    "Wordbar native drag saves once outside the inspector and Undo restores exact timing",
  );
  expect(registrations.wordbar).toHaveBeenLastCalledWith(main.page);
  const compat = await runCase(
    "Wordbar native boundary release and exact Undo work across browsers",
  );
  expect(registrations.wordbar).toHaveBeenLastCalledWith(compat.page);
  expect(main.viewport).toBeUndefined();
  expect(compat.viewport).toBeUndefined();
});
