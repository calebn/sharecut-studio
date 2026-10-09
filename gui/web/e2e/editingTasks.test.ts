import type { CDPSession, Locator, Page, Response } from "@playwright/test";
import { expect, it } from "vitest";
import { editingTaskRegistry } from "./editingTaskCases";
import {
  navigateEditingTimeline,
  performEditingInput,
  tabToEditingControl,
} from "./editingTaskInputs";
import type { EvidenceOrigin } from "./editingTaskReport";
import { editingResponseOutcome } from "./editingTasks";

it("records response-body failure at its originating request phase and status", async () => {
  const response = {
    status: () => 200,
    text: async () => {
      throw new Error(
        "Network.getResponseBody: No data found for resource with given identifier",
      );
    },
  } as unknown as Response;
  expect(
    await editingResponseOutcome(response, {
      id: 63,
      origin: { owner: "main", phase: "setup" },
      kind: "read",
    }),
  ).toEqual({
    owner: "main",
    phase: "setup",
    kind: "read-body-failed",
    errorName: "Error",
    requestId: 63,
    status: 200,
    error:
      "Error: Network.getResponseBody: No data found for resource with given identifier",
  });
  expect(
    await editingResponseOutcome(response, {
      id: 63,
      origin: { owner: "main", phase: "action" },
      kind: "command",
    }),
  ).toEqual({
    owner: "main",
    phase: "action",
    kind: "command-body-failed",
    requestId: 63,
    status: 200,
    errorName: "Error",
    error:
      "Error: Network.getResponseBody: No data found for resource with given identifier",
  });
});
it("navigates from Listen through counted Timeline input", async () => {
  let visible = false;
  const labels: string[] = [];
  const timeline = {
    isVisible: async () => visible,
    waitFor: async () => {
      if (!visible) throw new Error("Timeline unavailable");
    },
  };
  const button = {
    click: async () => {
      visible = true;
    },
  };
  const page = {
    locator: () => timeline,
    getByRole: () => ({ getByRole: () => button }),
  } as unknown as Page;
  await navigateEditingTimeline(page, async (control, label) => {
    labels.push(label);
    await control.click();
  });
  expect({ visible, labels }).toEqual({
    visible: true,
    labels: ["Primary Timeline"],
  });
  await navigateEditingTimeline(page, async (control, label) => {
    labels.push(label);
    await control.click();
  });
  expect(labels).toEqual(["Primary Timeline"]);
});
it("counts every Tab and Enter to open the shipped header", async () => {
  let tabs = 0,
    opened = false;
  const inputs: string[] = [];
  const control = {
    evaluate: async () => tabs === 3,
    _expect: async () => ({ matches: tabs === 3 }),
  } as unknown as Locator;
  await tabToEditingControl(control, async (value) => {
    inputs.push(value);
    if (value === "Tab") tabs++;
    else opened = true;
  });
  expect({ opened, inputs }).toEqual({
    opened: true,
    inputs: ["Tab", "Tab", "Tab", "Enter"],
  });
});

it("retains command body failure as one typed terminal with status captured before await", async () => {
  let status = 201;
  const response = {
    status: () => status,
    text: async () => {
      status = 503;
      throw new Error("native getter failed");
    },
  } as unknown as Response;
  expect(
    await editingResponseOutcome(response, {
      id: 77,
      origin: { owner: "main", phase: "action" },
      kind: "command",
    }),
  ).toEqual({
    owner: "main",
    phase: "action",
    kind: "command-body-failed",
    requestId: 77,
    status: 201,
    error: "Error: native getter failed",
    errorName: "Error",
  });
});

it.each([
  {
    thrown: "literal native string",
    error: "literal native string",
    errorName: null,
  },
  { thrown: null, error: "null", errorName: null },
  {
    thrown: {
      name: "NativeBodyError",
      toString: () => "literal named native error",
    },
    error: "literal named native error",
    errorName: "NativeBodyError",
  },
])(
  "retains arbitrary native thrown value $error",
  async ({ thrown, error, errorName }) => {
    const response = {
      status: () => 202,
      text: async () => {
        throw thrown;
      },
    } as unknown as Response;
    expect(
      await editingResponseOutcome(response, {
        id: 88,
        kind: "command",
        origin: { owner: "cancel", phase: "setup", probe: "short" },
      }),
    ).toEqual({
      owner: "cancel",
      phase: "setup",
      probe: "short",
      kind: "command-body-failed",
      requestId: 88,
      status: 202,
      error,
      errorName,
    });
  },
);
it("retains the original origin and observed status on a successful command body", async () => {
  let status = 201;
  const response = {
    status: () => status,
    text: async () => {
      status = 503;
      return '{"ok":true,"type":"Applied"}';
    },
  } as unknown as Response;
  expect(
    await editingResponseOutcome(response, {
      id: 99,
      kind: "command",
      origin: { owner: "main", phase: "undo" },
    }),
  ).toEqual({
    owner: "main",
    phase: "undo",
    kind: "response",
    requestId: 99,
    status: 201,
    body: '{"ok":true,"type":"Applied"}',
  });
});

it.each([
  { id: "short", x: 50, y: 10, end: "touchEnd" },
  { id: "vertical", x: 6, y: 40, end: "touchEnd" },
  { id: "touch-cancel", x: 6, y: 10, end: "touchCancel" },
])("executes the declared comment recipe $id", async ({ id, x, y, end }) => {
  const task = editingTaskRegistry.find((row) => row.id === "comment")!;
  const route = task.routes.find((row) => row.id === "trusted-touch-swipe")!;
  if ("pending" in route) throw new Error("Expected current route");
  const probe = route.cancellation.find((row) => row.id === id)!;
  const calls: unknown[] = [];
  const geometry = { x: 0, y: 0, width: 100, height: 20 };
  const control = {
    click: async () => {},
    boundingBox: async () => geometry,
    getByRole: () => control,
    locator: () => control,
    filter: () => control,
  };
  const active = {
    locator: () => control,
    getByRole: () => control,
  } as unknown as Page;
  const session = {
    send: async (method: string, payload: unknown) => {
      calls.push({ method, payload });
    },
  } as unknown as CDPSession;
  const labels: string[] = [],
    stages: string[] = [];
  await performEditingInput(
    { active, session, task, route, intent: { kind: "cancel", probe } },
    {
      act: async (_verb, label, action) => {
        labels.push(label);
        await action();
      },
      captureUi: async (_page, stage) => {
        stages.push(stage);
      },
      waitForActionResponses: async () => {},
    },
  );
  expect({ calls, labels, stages }).toEqual({
    calls: [
      {
        method: "Input.dispatchTouchEvent",
        payload: { type: "touchStart", touchPoints: [{ x: 70, y: 10 }] },
      },
      {
        method: "Input.dispatchTouchEvent",
        payload: { type: "touchMove", touchPoints: [{ x, y }] },
      },
      {
        method: "Input.dispatchTouchEvent",
        payload: { type: end, touchPoints: [] },
      },
    ],
    labels: ["Primary More", "Comments", `${id} comment cancellation`],
    stages: ["intermediate-swipe"],
  });
});

it("captures complete command ownership before native body retrieval can mutate its caller", async () => {
  const request: {
    id: number;
    kind: "command" | "read";
    origin: EvidenceOrigin;
  } = {
    id: 122,
    kind: "command",
    origin: { owner: "main", phase: "action" },
  };
  const response = {
    status: () => 202,
    text: async () => {
      request.id = 333;
      request.kind = "read";
      request.origin = { owner: "cancel", phase: "cancel", probe: "late" };
      throw new Error("literal native ownership mutation");
    },
  } as unknown as Response;
  expect(await editingResponseOutcome(response, request)).toEqual({
    owner: "main",
    phase: "action",
    kind: "command-body-failed",
    requestId: 122,
    status: 202,
    error: "Error: literal native ownership mutation",
    errorName: "Error",
  });
});
