import { afterEach, expect, it } from "vitest";
import {
  type FocusedClipHandle,
  focusedClipHandleKind,
  registerFocusedClipHandle,
  runFocusedClipHandle,
} from "./focusedClipHandle";

const disposers: Array<() => void> = [];

function register(session: FocusedClipHandle): void {
  disposers.push(registerFocusedClipHandle(session));
}

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) {
    dispose();
  }
});

it("routes edits to the current focused handle and preserves replacement ownership", () => {
  const actions: string[] = [];
  const fade: FocusedClipHandle = {
    kind: "fade",
    run: () => {
      actions.push("fade");
      return { status: "ok" };
    },
    cancel: () => actions.push("fade cancelled"),
  };
  const trim: FocusedClipHandle = {
    kind: "trim",
    run: (action) => {
      actions.push(
        action.phase === "nudge"
          ? `trim ${action.direction} ${action.shift ? "large" : "small"}`
          : `trim finish ${action.key ?? "blur"}`,
      );
      return { status: "ok" };
    },
    cancel: () => actions.push("trim cancelled"),
  };

  const disposeFade = registerFocusedClipHandle(fade);
  disposers.push(disposeFade);
  register(trim);
  expect(focusedClipHandleKind()).toBe("trim");
  expect(actions).toEqual(["fade cancelled"]);

  disposeFade();
  expect(focusedClipHandleKind()).toBe("trim");
  expect(
    runFocusedClipHandle("trim", {
      phase: "nudge",
      direction: 1,
      shift: true,
    }),
  ).toEqual({ status: "ok" });
  expect(actions.at(-1)).toBe("trim 1 large");
  expect(
    runFocusedClipHandle("trim", { phase: "finish", key: "ArrowLeft" }),
  ).toEqual({ status: "ok" });
  expect(actions.at(-1)).toBe("trim finish ArrowLeft");
  expect(
    runFocusedClipHandle("fade", {
      phase: "nudge",
      direction: 1,
      shift: false,
    }),
  ).toMatchObject({ status: "disabled" });
  expect(actions).not.toContain("fade");
});

it("rejects malformed actions without changing the active preview", () => {
  const actions: string[] = [];
  register({
    kind: "fade",
    run: () => {
      actions.push("preview changed");
      return { status: "ok" };
    },
    cancel: () => undefined,
  });

  expect(
    runFocusedClipHandle("fade", {
      phase: "nudge",
      direction: 0,
      shift: true,
    }),
  ).toMatchObject({ status: "disabled" });
  expect(actions).toEqual([]);
});
