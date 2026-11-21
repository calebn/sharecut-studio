import { expect, it, vi } from "vitest";
import { startDawSession } from "../../api/dawExport";
import { useDawStore } from "../../state/dawStore";
import { deferred } from "../../test/deferred";
import type { PipelineJobSnapshot } from "../../types/pipeline";
import { exportDawSession } from "./runDawExport";

vi.mock("../../api/dawExport", () => ({ startDawSession: vi.fn() }));

it("admits one export across callers while the host decides whether to start it", async () => {
  useDawStore.setState({ projectPath: "/episode" });
  const admission = deferred<PipelineJobSnapshot>();
  vi.mocked(startDawSession).mockReturnValueOnce(admission.promise);
  const first = exportDawSession("/episode", "sesx");
  await expect(exportDawSession("/episode", "rpp")).rejects.toThrow(
    "A DAW export is already running.",
  );
  expect(startDawSession).toHaveBeenCalledTimes(1);
  admission.reject(new Error("The host refused the export."));
  await expect(first).rejects.toThrow("The host refused the export.");
  vi.mocked(startDawSession).mockRejectedValueOnce(
    new Error("This installation does not include the optional AAF writer."),
  );
  await expect(exportDawSession("/episode", "aaf")).rejects.toThrow(
    "optional AAF writer",
  );
});
