import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../../state/dawStore";
import {
  scriptUtterance,
  scriptWord,
  seedScript,
} from "../../../test/scriptHostKit";
import { ScriptHost } from "./ScriptHost";

const preview = vi.hoisted(() => vi.fn());
const replace = vi.hoisted(() => vi.fn());
vi.mock("../../../api", async (original) => ({
  ...(await original<typeof import("../../../api")>()),
  previewTranscriptReplacement: preview,
  replaceTranscriptMatches: replace,
}));
vi.mock("../../../commands/seek", () => ({ seekTransport: vi.fn() }));

const bar = () => screen.getByRole("search", { name: "Find in transcript" });
const findField = () => screen.getByRole("searchbox", { name: "Find" });

async function openFind() {
  render(<ScriptHost />);
  await userEvent.click(
    screen.getByRole("button", { name: "Find in transcript" }),
  );
}

beforeEach(() => {
  preview.mockReset();
  replace.mockReset();
  preview.mockResolvedValue({
    matches: [],
    count: 2,
    skipped_words: 0,
    preview_token: "tok-1",
  });
  replace.mockResolvedValue({ queued: false });
  seedScript();
});

describe("ScriptHost Find", () => {
  it("counts matches and says the count in the pane's live region", async () => {
    await openFind();
    await userEvent.type(findField(), "maya");
    expect(bar()).toHaveTextContent("1 of 1");
    expect(
      screen.getAllByRole("status").map((region) => region.textContent),
    ).toContain("1 of 1");
    await userEvent.clear(findField());
    await userEvent.type(findField(), "zzz");
    expect(bar()).toHaveTextContent("No matches");
  });

  it("marks the current match and steps through the hits with Enter", async () => {
    seedScript({
      utterances: [
        scriptUtterance("host", "Maya", [
          scriptWord("go", 0, 1),
          scriptWord("on", 1, 2),
          scriptWord("go", 2, 3),
        ]),
      ],
    });
    await openFind();
    await userEvent.type(findField(), "go");
    expect(bar()).toHaveTextContent("1 of 2");
    expect(
      screen.getAllByRole("button", { name: /^go/ })[0],
    ).toHaveAccessibleName("go (current match)");
    await userEvent.keyboard("{Enter}");
    expect(bar()).toHaveTextContent("2 of 2");
    expect(
      screen.getAllByRole("button", { name: /^go/ })[1],
    ).toHaveAccessibleName("go (current match)");
    await userEvent.keyboard("{Enter}");
    expect(bar()).toHaveTextContent("1 of 2");
    await userEvent.click(
      screen.getByRole("button", { name: "Previous match" }),
    );
    expect(bar()).toHaveTextContent("2 of 2");
  });

  it("closes on Escape and gives focus back to the Find button", async () => {
    await openFind();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("search")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Find in transcript" }),
    ).toHaveFocus();
  });

  it("selects every hit as one range over their time", async () => {
    await openFind();
    await userEvent.type(findField(), "maya");
    await userEvent.click(screen.getByRole("button", { name: /Select all 1/ }));
    expect(useDawStore.getState().selection?.kind).toBe("range");
  });

  it("replaces all through the preview token and toasts without a count", async () => {
    await openFind();
    await userEvent.type(findField(), "maya");
    await userEvent.click(screen.getByRole("button", { name: "Show replace" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Replace with" }),
      "Maia",
    );
    await userEvent.click(screen.getByRole("button", { name: "Replace all" }));
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(preview).toHaveBeenCalledWith("/tmp/ep", {
      search: "maya",
      replacement: "Maia",
      match_case: false,
    });
    expect(replace).toHaveBeenCalledWith(
      "/tmp/ep",
      { search: "maya", replacement: "Maia", match_case: false },
      "tok-1",
    );
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Replaced the matching words",
      ),
    );
    expect(useDawStore.getState().statusAnnouncement).not.toMatch(/\d/);
  });

  it("says a queued replace is still sending, with no count", async () => {
    replace.mockResolvedValue({ queued: true });
    await openFind();
    await userEvent.type(findField(), "maya");
    await userEvent.click(screen.getByRole("button", { name: "Show replace" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Replace with" }),
      "Maia",
    );
    await userEvent.click(screen.getByRole("button", { name: "Replace all" }));
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Replace queued. Still sending.",
      ),
    );
  });

  it("shows the backend's refusal in the bar", async () => {
    preview.mockResolvedValue({
      matches: [],
      count: 0,
      skipped_words: 3,
      preview_token: "t",
    });
    await openFind();
    await userEvent.type(findField(), "maya");
    await userEvent.click(screen.getByRole("button", { name: "Show replace" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Replace with" }),
      "Maia",
    );
    await userEvent.click(screen.getByRole("button", { name: "Replace all" }));
    expect(await screen.findByText("No words to replace.")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("explains that a single Replace is not there yet", async () => {
    await openFind();
    await userEvent.type(findField(), "maya");
    await userEvent.click(screen.getByRole("button", { name: "Show replace" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Replace with" }),
      "Maia",
    );
    await userEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(await screen.findByText(/Use Replace all/)).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("offers no Cut all", async () => {
    await openFind();
    await userEvent.type(findField(), "maya");
    expect(screen.queryByRole("button", { name: /Cut all/ })).toBeNull();
  });
});
