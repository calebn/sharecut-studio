import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { cancelPipelineRun } from "../../api";
import { loadDawFormats } from "../../api/dawExport";
import { exportDawSession } from "../../stage/hosts/runDawExport";
import { useDawStore } from "../../state/dawStore";
import { deferred } from "../../test/deferred";
import { pipelineJobSnapshot } from "../../test/fixtures";
import { DawSession } from "./DawSession";

vi.mock("../../api/dawExport", () => ({
  loadDawFormats: vi.fn(),
}));
vi.mock("../../stage/hosts/runDawExport", async (original) => ({
  ...(await original<typeof import("../../stage/hosts/runDawExport")>()),
  exportDawSession: vi.fn(),
}));
vi.mock("../../api", async (original) => ({
  ...(await original<typeof import("../../api")>()),
  cancelPipelineRun: vi.fn(),
}));
const files = { files: [], access: "download" } as const;
const props = {
  projectPath: "/one",
  files,
  reload: vi.fn(),
  fileLoad: "ready",
  filesRunning: false,
} as const;
const available = { rpp: null, sesx: null, aaf: null };
const button = () => screen.getByRole("button", { name: "Export DAW session" });
beforeEach(() => {
  vi.resetAllMocks();
  useDawStore.setState({ activityJob: null });
  vi.mocked(loadDawFormats).mockResolvedValue(available);
});

it("shows availability, native import evidence and the WAV alternative before starting", async () => {
  vi.mocked(loadDawFormats).mockResolvedValue({
    ...available,
    aaf: "AAF writer is unavailable.",
  });
  const user = userEvent.setup();
  const { rerender } = render(<DawSession {...props} />);
  expect(button()).toBeDisabled();
  const format = screen.getByLabelText("DAW format");
  await user.selectOptions(format, "aaf");
  expect(await screen.findByText("AAF writer is unavailable.")).toBeVisible();
  expect(button()).toBeDisabled();
  expect(
    screen.getByText(
      /Logic Pro 12.4 and Ardour 8.12.*Pro Tools import is unverified/,
    ),
  ).toBeVisible();
  await user.selectOptions(format, "rpp");
  expect(screen.getByText(/REAPER 7.86 on Linux/)).toBeVisible();
  expect(button()).toBeEnabled();
  rerender(<DawSession {...props} saveBlocker="Saving your changes first." />);
  expect(button()).toHaveAccessibleDescription("Saving your changes first.");
  expect(screen.getByText(/use WAV in Episode file/)).toBeVisible();
});

it("retries an availability check and a refused job without starting twice", async () => {
  vi.mocked(loadDawFormats).mockRejectedValueOnce(new Error("Offline"));
  vi.mocked(exportDawSession).mockRejectedValueOnce(
    new Error("Another job is still running."),
  );
  const run = deferred<string>();
  vi.mocked(exportDawSession).mockReturnValueOnce(run.promise);
  const user = userEvent.setup();
  render(<DawSession {...props} />);
  await user.selectOptions(screen.getByLabelText("DAW format"), "sesx");
  await user.click(
    await screen.findByRole("button", { name: "Check formats again" }),
  );
  await waitFor(() => expect(button()).toBeEnabled());
  await user.click(button());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Another job is still running.",
  );
  await user.click(button());
  fireEvent.click(button());
  expect(button()).toBeDisabled();
  expect(exportDawSession).toHaveBeenCalledTimes(2);
  run.resolve("daw-abc/session-sesx.zip");
  expect(
    await screen.findByRole("button", { name: "Refresh files" }),
  ).toBeVisible();
});

it("drops the old receipt when the open episode changes during export", async () => {
  const run = deferred<string>();
  vi.mocked(exportDawSession).mockReturnValue(run.promise);
  const user = userEvent.setup();
  const view = render(<DawSession {...props} key="one" />);
  await user.selectOptions(screen.getByLabelText("DAW format"), "rpp");
  await user.click(button());
  expect(button()).toHaveAccessibleDescription("Exporting the saved timeline…");
  view.rerender(<DawSession {...props} projectPath="/two" key="two" />);
  run.resolve("daw-abc/session-rpp.zip");
  await run.promise;
  expect(props.reload).not.toHaveBeenCalled();
  expect(screen.getByLabelText("DAW format")).toHaveValue("");
  expect(button()).toHaveAccessibleDescription("Choose a DAW format.");
  expect(screen.queryByText("DAW session exported.")).toBeNull();
});

it("shows the real phase on re-entry and cancels only that episode’s job", async () => {
  const tracked = pipelineJobSnapshot({
    kind: "daw_export",
    project_path: props.projectPath,
    message: "Packing the session and audio",
    current: 2,
    total: 5,
  });
  useDawStore.setState({ activityJob: tracked });
  const user = userEvent.setup();
  const view = render(<DawSession {...props} />);
  expect(
    screen.getByText(/Packing the session and audio.*2\/5 steps.*Elapsed/),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(cancelPipelineRun).toHaveBeenCalledWith(tracked.id);
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  view.rerender(<DawSession {...props} key="two" projectPath="/two" />);
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  expect(screen.getByLabelText("DAW format")).toBeEnabled();
});
