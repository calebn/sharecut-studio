import type { Locator, Page, Response } from "@playwright/test";
import { expect, it } from "vitest";
import {
  navigateEditingTimeline,
  tabToEditingControl,
} from "./editingTaskInputs";
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
      phase: "setup",
      kind: "read",
    }),
  ).toEqual({
    phase: "setup",
    kind: "read-body-failed",
    requestId: 63,
    status: 200,
    error:
      "Error: Network.getResponseBody: No data found for resource with given identifier",
  });
  expect(
    await editingResponseOutcome(response, {
      id: 63,
      phase: "action",
      kind: "command",
    }),
  ).toEqual({
    phase: "action",
    kind: "error",
    message:
      "response 63: Error: Network.getResponseBody: No data found for resource with given identifier",
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
