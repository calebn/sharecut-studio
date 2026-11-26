import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { stubViewportShell } from "../test/viewportShell";
import { MIXED_KIT, UNCHANGED_KIT, waitingKit } from "./fixtures";
import { KitImportPreview } from "./KitImportPreview";
import type { KitImportState } from "./useKitImport";

const onAdd = vi.fn();
const onCancel = vi.fn();
const onChooseAgain = vi.fn();

function show(state: KitImportState) {
  return render(
    <KitImportPreview
      state={state}
      onAdd={onAdd}
      onCancel={onCancel}
      onChooseAgain={onChooseAgain}
    />,
  );
}

const waiting = (preview = waitingKit(), notice: string | null = null) =>
  ({ phase: "preview", preview, notice }) as const;

beforeEach(() => {
  stubViewportShell("desktop");
  useDawStore.setState({ guestMode: null });
  onAdd.mockReset();
  onCancel.mockReset();
  onChooseAgain.mockReset();
});

describe("KitImportPreview", () => {
  it("shows the name, outcome line and counts of a new kit", async () => {
    show(waiting());
    const sheet = await screen.findByRole("dialog", { name: "Import a kit" });
    expect(
      within(sheet).getByRole("heading", { name: "Show Kit" }),
    ).toBeVisible();
    expect(within(sheet).getByRole("status")).toHaveTextContent(
      "Adds Show Kit",
    );
    expect(within(sheet).getByText("2 segments: 2 new")).toBeVisible();
  });

  it.each([
    [{ outcome: "new_version" as const, version: 2 }, "Adds as Show Kit v2"],
    [
      {
        outcome: "unchanged" as const,
        counts: { added: 1, new_version: 0, unchanged: 1 },
      },
      "Already in your library, with new segments to add",
    ],
  ])("says what adding does: %j", async (over, line) => {
    show(waiting(waitingKit(over)));
    const sheet = await screen.findByRole("dialog", { name: "Import a kit" });
    expect(within(sheet).getByRole("status")).toHaveTextContent(line);
    expect(
      within(sheet).getByRole("button", { name: "Add to library" }),
    ).toBeVisible();
  });

  it("lists the entries in kit order with kind, length, placement, note and a status chip", async () => {
    const shuffled = {
      ...MIXED_KIT,
      entries: [...MIXED_KIT.entries].reverse(),
    };
    show(waiting(shuffled));
    const sheet = await screen.findByRole("dialog", { name: "Import a kit" });
    expect(
      within(sheet).getByText(
        "3 segments: 1 new, 1 new version, 1 already there",
      ),
    ).toBeVisible();
    const list = within(sheet).getByRole("list", { name: "Kit entries" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Cold openIntro0:12At startAlready there",
      "Sponsor readSponsor0:31At 1:20New version v2Move to after the first break if the episode is under 20 minutes.",
      "Sign offOutro0:20At endNew",
    ]);
  });

  it("offers no Play, because a staged kit has no audio to hear", async () => {
    show(waiting(MIXED_KIT));
    const sheet = await screen.findByRole("dialog", { name: "Import a kit" });
    expect(within(sheet).queryByRole("button", { name: /play/i })).toBeNull();
  });

  it("offers Cancel and Add, with Add first in focus, and calls them", async () => {
    show(waiting());
    const sheet = await screen.findByRole("dialog", { name: "Import a kit" });
    const add = within(sheet).getByRole("button", { name: "Add to library" });
    await vi.waitFor(() => expect(add).toHaveFocus());
    await userEvent.click(add);
    expect(onAdd).toHaveBeenCalledTimes(1);
    await userEvent.click(
      within(sheet).getByRole("button", { name: "Cancel" }),
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("gives an entirely unchanged kit Close only", async () => {
    show(waiting(UNCHANGED_KIT));
    const sheet = await screen.findByRole("dialog", { name: "Import a kit" });
    expect(within(sheet).getByRole("status")).toHaveTextContent(
      "Already in your library",
    );
    expect(
      within(sheet).queryByRole("button", { name: "Add to library" }),
    ).toBeNull();
    expect(within(sheet).queryByRole("button", { name: "Cancel" })).toBeNull();
    const footer = sheet.querySelector(".sys-segment-actions") as HTMLElement;
    expect(within(footer).getAllByRole("button")).toHaveLength(1);
    const close = within(footer).getByRole("button", { name: "Close" });
    await vi.waitFor(() => expect(close).toHaveFocus());
    await userEvent.click(close);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows the checking line while the file uploads", async () => {
    show({ phase: "uploading", fileName: "show.sharecutkit" });
    const sheet = await screen.findByRole("dialog", { name: "Import a kit" });
    expect(within(sheet).getByRole("status")).toHaveTextContent(
      "Checking show.sharecutkit…",
    );
    expect(within(sheet).getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("disables both buttons while adding", async () => {
    show({ phase: "committing", preview: waitingKit() });
    const sheet = await screen.findByRole("dialog", { name: "Import a kit" });
    expect(
      within(sheet).getByRole("button", { name: "Adding…" }),
    ).toBeDisabled();
    expect(
      within(sheet).getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    expect(
      within(sheet).getByRole("list", { name: "Kit entries" }),
    ).toBeVisible();
  });

  it("keeps the kit and shows the notice when adding can be tried again", async () => {
    show(
      waiting(
        waitingKit(),
        "Another program is changing the library. Added 1 of 2 segments. Choose Add to library to finish.",
      ),
    );
    const sheet = await screen.findByRole("dialog", { name: "Import a kit" });
    expect(within(sheet).getByRole("alert")).toHaveTextContent(
      "Added 1 of 2 segments.",
    );
    expect(
      within(sheet).getByRole("button", { name: "Add to library" }),
    ).toBeEnabled();
  });

  it("shows a refused file's message with Close and Choose another file", async () => {
    show({
      phase: "error",
      fileName: "show.sharecutkit",
      message: "This kit file is damaged.",
    });
    const sheet = await screen.findByRole("dialog", { name: "Import a kit" });
    expect(within(sheet).getByRole("alert")).toHaveTextContent(
      "This kit file is damaged.",
    );
    expect(within(sheet).getByText("show.sharecutkit")).toBeVisible();
    await userEvent.click(
      within(sheet).getByRole("button", { name: "Choose another file" }),
    );
    expect(onChooseAgain).toHaveBeenCalledTimes(1);
  });

  it("renders nothing while idle", () => {
    show({ phase: "idle" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is a bottom sheet on a phone and axe-clean in both forms", async () => {
    stubViewportShell("phone");
    const phone = show(waiting(MIXED_KIT));
    const sheet = await screen.findByRole("dialog", { name: "Import a kit" });
    await expectNoA11yViolations(sheet);
    phone.unmount();
    stubViewportShell("desktop");
    show(waiting(MIXED_KIT));
    await expectNoA11yViolations(
      await screen.findByRole("dialog", { name: "Import a kit" }),
    );
  });
});
