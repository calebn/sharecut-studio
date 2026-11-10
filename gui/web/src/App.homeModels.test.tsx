import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { resetFeaturesCache } from "./extensions/features";
import { useDawStore } from "./state/dawStore";
import { modelRow, modelStatus, registryRows } from "./test/renderWithModels";
import { urlOf } from "./test/urlOf";

const json = (body: unknown, status = 200, code?: string) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(code ? { "X-Sharecut-Error-Code": code } : {}),
    },
  });

function mountHomeModels(refusal?: {
  status: number;
  code?: string;
  detail: string;
}) {
  let rows = registryRows().map((row) =>
    row.id === "rnnoise" ? modelRow({ ...row, state: "installed" }) : row,
  );
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (
        url.endsWith("/api/bootstrap/models/rnnoise") &&
        method === "DELETE"
      ) {
        if (refusal) {
          return json({ detail: refusal.detail }, refusal.status, refusal.code);
        }
        rows = rows.map((row) =>
          row.id === "rnnoise" ? modelRow({ ...row, state: "missing" }) : row,
        );
        return json({
          freed_bytes: 297_646,
          model: rows.find((row) => row.id === "rnnoise"),
        });
      }
      if (url.includes("/api/bootstrap/status-job")) {
        return json({ job: null });
      }
      if (url.includes("/api/bootstrap/status")) {
        return json(modelStatus(rows));
      }
      if (url.includes("/api/projects/recent")) {
        return json({ projects: [] });
      }
      if (url.includes("/features")) {
        return json({ api_version: 1, features: [] });
      }
      return json({});
    }),
  );
  const user = userEvent.setup();
  render(<App />);
  const deletes = () => calls.filter((call) => call.method === "DELETE");
  const openRemove = async () => {
    await user.click(
      await screen.findByRole("button", { name: "ShareCut app menu" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Settings" }));
    const sheet = await screen.findByRole("dialog", { name: "Models" });
    expect(within(sheet).getByText("Installed · 0.3 MB")).toBeVisible();
    await user.click(
      within(sheet).getByRole("button", { name: "More for Noise reduction" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Remove Noise reduction" }),
    );
    const ask = await screen.findByRole("dialog", {
      name: "Remove Noise reduction?",
    });
    expect(
      screen.getAllByRole("dialog", { name: "Remove Noise reduction?" }),
    ).toHaveLength(1);
    expect(ask).toBeVisible();
    expect(deletes()).toEqual([]);
    return { sheet, ask };
  };
  return { user, deletes, openRemove };
}

describe("App on Home: Models sheet", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        callback: (
          entries: { isIntersecting: boolean; intersectionRatio: number }[],
        ) => void;
        constructor(
          callback: (
            entries: { isIntersecting: boolean; intersectionRatio: number }[],
          ) => void,
        ) {
          this.callback = callback;
        }
        observe() {
          this.callback([{ isIntersecting: true, intersectionRatio: 1 }]);
        }
        disconnect() {}
      },
    );
    resetFeaturesCache();
    window.history.pushState({}, "", "/");
    useDawStore.getState().setModelsSheetOpen(false);
    useDawStore.setState({ statusAnnouncement: "", feedbackToast: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetFeaturesCache();
  });

  it("asks before Remove and deletes the model once the person confirms", async () => {
    const { user, deletes, openRemove } = mountHomeModels();
    const { sheet, ask } = await openRemove();
    await user.click(within(ask).getByRole("button", { name: "Remove" }));
    expect(
      await within(sheet).findByRole("button", { name: "Get Noise reduction" }),
    ).toBeVisible();
    expect(within(sheet).getByText("Not installed · 0.3 MB")).toBeVisible();
    expect(deletes()).toEqual([
      { url: "/api/bootstrap/models/rnnoise", method: "DELETE" },
    ]);
    expect(
      screen.queryByRole("dialog", { name: "Remove Noise reduction?" }),
    ).toBeNull();
  });

  it("keeps the installed model when Remove is cancelled", async () => {
    const { user, deletes, openRemove } = mountHomeModels();
    const { sheet, ask } = await openRemove();
    await user.click(within(ask).getByRole("button", { name: "Keep it" }));
    expect(
      screen.queryByRole("dialog", { name: "Remove Noise reduction?" }),
    ).toBeNull();
    expect(within(sheet).getByText("Installed · 0.3 MB")).toBeVisible();
    expect(
      within(sheet).getByRole("button", { name: "More for Noise reduction" }),
    ).toBeVisible();
    expect(deletes()).toEqual([]);
  });

  it.each([
    {
      status: 409,
      code: "pipeline_busy",
      detail: "A pipeline job is running.",
      feedback: "Noise reduction stays: a download or job is running.",
    },
    {
      status: 500,
      detail: "The model file could not be removed.",
      feedback:
        "Couldn't remove Noise reduction. The model file could not be removed.",
    },
  ])(
    "keeps the installed model when the server refuses Remove ($status)",
    async ({ feedback, ...refusal }) => {
      const { user, deletes, openRemove } = mountHomeModels(refusal);
      const { sheet, ask } = await openRemove();
      await user.click(within(ask).getByRole("button", { name: "Remove" }));
      await waitFor(() =>
        expect(useDawStore.getState().statusAnnouncement).toBe(feedback),
      );
      expect(
        within(
          screen.getByRole("region", { name: "Status messages" }),
        ).getByText(feedback),
      ).toBeVisible();
      expect(
        screen.queryByRole("dialog", { name: "Remove Noise reduction?" }),
      ).toBeNull();
      expect(within(sheet).getByText("Installed · 0.3 MB")).toBeVisible();
      expect(
        within(sheet).getByRole("button", { name: "More for Noise reduction" }),
      ).toBeVisible();
      expect(
        within(sheet).queryByRole("button", { name: "Get Noise reduction" }),
      ).toBeNull();
      expect(deletes()).toEqual([
        { url: "/api/bootstrap/models/rnnoise", method: "DELETE" },
      ]);
    },
  );
});
