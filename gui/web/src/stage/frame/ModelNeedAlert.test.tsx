import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import {
  modelStatus,
  modelsApi,
  modelsWrapper,
  registryRows,
} from "../../test/renderWithModels";
import { FrameAlerts } from "./FrameAlerts";
import { ModelNeedAlert } from "./ModelNeedAlert";
import { FRAME_ALERT_PRIORITY, useFrameAlert } from "./useFrameAlert";

const WHISPER = {
  id: "whisper",
  variant: "large-v3-turbo",
  label: "Whisper",
  size: "~1.6 GB",
};

function Failure() {
  useFrameAlert(FRAME_ALERT_PRIORITY.failed, {
    state: "failed",
    title: "Could not resume the run.",
  });
  return null;
}

const wrapper = () =>
  modelsWrapper(modelsApi({ status: modelStatus(registryRows()) }));

it("shows the model need as the slot's row with Get", async () => {
  render(
    <FrameAlerts>
      <ModelNeedAlert model={WHISPER} />
    </FrameAlerts>,
    { wrapper: wrapper() },
  );
  const row = within(await screen.findByRole("status"));
  expect((await row.findAllByText(/^Needs/))[0]).toBeVisible();
  expect(row.getByRole("button", { name: /^Get/ })).toBeVisible();
});

it("puts a failed run above the model need and counts the need behind +1", async () => {
  render(
    <FrameAlerts>
      <ModelNeedAlert model={WHISPER} />
      <Failure />
    </FrameAlerts>,
    { wrapper: wrapper() },
  );
  expect(await screen.findByText("Could not resume the run.")).toBeVisible();
  expect(screen.queryByText(/^Needs/)).toBeNull();
  expect(screen.getByRole("button", { name: "1 more alert" })).toBeVisible();
});
