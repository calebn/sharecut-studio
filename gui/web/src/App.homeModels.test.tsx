import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { resetFeaturesCache } from "./extensions/features";
import { modelRow, modelStatus, registryRows } from "./test/renderWithModels";
import { urlOf } from "./test/urlOf";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("App on Home: Models sheet", () => {
  beforeEach(() => {
    resetFeaturesCache();
    window.history.pushState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetFeaturesCache();
  });

  it("asks before Remove and deletes the model once the person confirms", async () => {
    const rows = registryRows().map((row) =>
      row.id === "rnnoise" ? modelRow({ ...row, state: "installed" }) : row,
    );
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        calls.push({ url, method: init?.method ?? "GET" });
        if (url.includes("/api/bootstrap/models/")) {
          return json({ ok: true, freed_bytes: 297_646 });
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

    await user.click(await screen.findByRole("button", { name: /^Choose/ }));
    const sheet = await screen.findByRole("dialog", { name: /Models/ });
    await user.click(
      await within(sheet).findByRole("button", {
        name: "More for Noise reduction",
      }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Remove Noise reduction" }),
    );

    const ask = await screen.findByRole("dialog", {
      name: "Remove Noise reduction?",
    });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(within(ask).getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(
        calls.filter(
          (c) => c.method === "DELETE" && c.url.endsWith("/models/rnnoise"),
        ),
      ).toHaveLength(1),
    );
  });
});
