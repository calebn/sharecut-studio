import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject, sampleComment, sampleTrack } from "../test/fixtures";
import { MobileShell } from "./MobileShell";

const createComment = vi.hoisted(() => vi.fn());

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  createComment: (...args: unknown[]) => createComment(...args),
}));

vi.mock("../services/offlineQueue/offlineStore", () => ({
  loadConflicts: vi.fn().mockResolvedValue([]),
  loadCommandQueue: vi.fn().mockResolvedValue([]),
  loadHostCommandCount: vi.fn().mockResolvedValue(0),
  loadHostConflicts: vi.fn().mockResolvedValue([]),
  loadHostAttention: vi.fn().mockResolvedValue({ pending: 0, conflicts: [] }),
  loadGuestAttention: vi.fn().mockResolvedValue({ pending: 0, conflicts: [] }),
}));

vi.mock("../waveform/statusStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../waveform/statusStore")>()),
  useWaveformStatus: () => null,
  useLaneWaveformStatus: () => "idle",
}));

const project = minimalProject({ tracks: [sampleTrack({ id: "host" })] });

function openGuest() {
  return render(
    <DawProvider
      projectPath="share:tok"
      initialProject={project}
      guestMode="comment"
      shareCapabilities={["view", "comment"]}
    >
      <MobileShell guestShare />
    </DawProvider>,
  );
}

function openHost() {
  return render(
    <DawProvider projectPath="/tmp/p.json" initialProject={project}>
      <MobileShell />
    </DawProvider>,
  );
}

function dock() {
  return screen.getByRole("region", { name: "Add a comment" });
}

async function typeComment(
  user: ReturnType<typeof userEvent.setup>,
  text: string,
) {
  await user.type(
    within(dock()).getByRole("textbox", { name: "Comment" }),
    text,
  );
}

async function post(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    within(dock()).getByRole("button", { name: "Post comment" }),
  );
}

function lastAuthor(): string {
  const [, input] = createComment.mock.calls.at(-1) ?? [];
  return (input as { author: string }).author;
}

describe("phone share link, a guest names themselves", () => {
  beforeEach(() => {
    localStorage.clear();
    clearRegisteredCommands();
    registerDawCommands();
    createComment.mockReset();
    createComment.mockResolvedValue(sampleComment({ id: "c9" }));
    useDawStore.getState().hydrate("/tmp/reset.json", minimalProject());
    useDawStore.getState().setShellBreakpoint("phone");
    useDawStore.getState().setMobileMode("listen");
  });

  afterEach(() => {
    clearRegisteredCommands();
    vi.restoreAllMocks();
  });

  it("asks for a name on the first Post, keeps the comment text, and does not post yet", async () => {
    const user = userEvent.setup();
    const { container } = openGuest();
    expect(
      within(dock()).queryByRole("textbox", { name: "Your name" }),
    ).toBeNull();
    await typeComment(user, "Love this");
    await post(user);

    expect(createComment).not.toHaveBeenCalled();
    const name = within(dock()).getByRole("textbox", { name: "Your name" });
    expect(name).toHaveFocus();
    expect(within(dock()).getByRole("button", { name: "Skip" })).toBeVisible();
    expect(
      within(dock()).getByRole("textbox", { name: "Comment" }),
    ).toHaveValue("Love this");
    await expectNoA11yViolations(container);
  });

  it("posts under the typed name, remembers it, and never asks again", async () => {
    const user = userEvent.setup();
    openGuest();
    await typeComment(user, "First");
    await post(user);
    await user.type(
      within(dock()).getByRole("textbox", { name: "Your name" }),
      "  Sam Lee ",
    );
    await post(user);

    expect(createComment).toHaveBeenCalledTimes(1);
    expect(lastAuthor()).toBe("Sam Lee");
    expect(localStorage.getItem("podcast-mcp-guest-comment-name")).toBe(
      "Sam Lee",
    );
    expect(
      within(dock()).queryByRole("textbox", { name: "Your name" }),
    ).toBeNull();
    expect(within(dock()).getByText("Sam Lee")).toBeVisible();
    expect(
      within(dock()).getByRole("button", { name: "Change your comment name" }),
    ).toBeVisible();

    await typeComment(user, "Second");
    await post(user);
    expect(createComment).toHaveBeenCalledTimes(2);
    expect(lastAuthor()).toBe("Sam Lee");
    expect(
      within(dock()).queryByRole("textbox", { name: "Your name" }),
    ).toBeNull();
  });

  it("Enter in the name field posts the comment", async () => {
    const user = userEvent.setup();
    openGuest();
    await typeComment(user, "Hi");
    await post(user);
    await user.type(
      within(dock()).getByRole("textbox", { name: "Your name" }),
      "Kit{Enter}",
    );
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(lastAuthor()).toBe("Kit");
  });

  it("Skip posts as Guest and is not asked again", async () => {
    const user = userEvent.setup();
    openGuest();
    await typeComment(user, "One");
    await post(user);
    await user.click(within(dock()).getByRole("button", { name: "Skip" }));
    expect(lastAuthor()).toBe("Guest");
    expect(within(dock()).getByText("Guest")).toBeVisible();

    await typeComment(user, "Two");
    await post(user);
    expect(createComment).toHaveBeenCalledTimes(2);
    expect(lastAuthor()).toBe("Guest");
    expect(
      within(dock()).queryByRole("textbox", { name: "Your name" }),
    ).toBeNull();
  });

  it("an empty name field posts as Guest", async () => {
    const user = userEvent.setup();
    openGuest();
    await typeComment(user, "One");
    await post(user);
    await post(user);
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(lastAuthor()).toBe("Guest");
  });

  it("caps the name at 40 characters", async () => {
    const user = userEvent.setup();
    openGuest();
    await typeComment(user, "One");
    await post(user);
    await user.type(
      within(dock()).getByRole("textbox", { name: "Your name" }),
      "n".repeat(60),
    );
    await post(user);
    expect(lastAuthor()).toBe("n".repeat(40));
  });

  it("the host's saved name neither names the guest nor skips the prompt", async () => {
    const user = userEvent.setup();
    localStorage.setItem("podcast-mcp-comment-author", "Dana");
    openGuest();
    expect(within(dock()).queryByText("Dana")).toBeNull();
    await typeComment(user, "Hello");
    await post(user);
    expect(createComment).not.toHaveBeenCalled();
    expect(
      within(dock()).getByRole("textbox", { name: "Your name" }),
    ).toBeVisible();
    expect(localStorage.getItem("podcast-mcp-comment-author")).toBe("Dana");
  });

  it("caps the name by code points, not UTF-16 units", async () => {
    const user = userEvent.setup();
    openGuest();
    await typeComment(user, "One");
    await post(user);
    await user.click(
      within(dock()).getByRole("textbox", { name: "Your name" }),
    );
    await user.paste("\u{1F600}".repeat(50));
    await post(user);
    expect(Array.from(lastAuthor())).toHaveLength(40);
  });

  it("a name of only invisible characters posts as Guest", async () => {
    const user = userEvent.setup();
    openGuest();
    await typeComment(user, "One");
    await post(user);
    await user.type(
      within(dock()).getByRole("textbox", { name: "Your name" }),
      "\u200b\u200d",
    );
    await post(user);
    expect(lastAuthor()).toBe("Guest");
  });

  it("a name saved earlier is used without asking", async () => {
    const user = userEvent.setup();
    localStorage.setItem("podcast-mcp-guest-comment-name", "Mina");
    openGuest();
    expect(within(dock()).getByText("Mina")).toBeVisible();
    await typeComment(user, "Back again");
    await post(user);
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(lastAuthor()).toBe("Mina");
  });

  it("Change renames the guest for the next comment", async () => {
    const user = userEvent.setup();
    localStorage.setItem("podcast-mcp-guest-comment-name", "Mina");
    openGuest();
    await user.click(
      within(dock()).getByRole("button", { name: "Change your comment name" }),
    );
    const field = within(dock()).getByRole("textbox", { name: "Your name" });
    await user.clear(field);
    await user.type(field, "Jo{Enter}");
    expect(within(dock()).getByText("Jo")).toBeVisible();
    expect(localStorage.getItem("podcast-mcp-guest-comment-name")).toBe("Jo");
    await typeComment(user, "Renamed");
    await post(user);
    expect(lastAuthor()).toBe("Jo");
  });

  it("works with storage blocked: asks once per page load and still posts", async () => {
    const user = userEvent.setup();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    openGuest();
    await typeComment(user, "One");
    await post(user);
    await user.type(
      within(dock()).getByRole("textbox", { name: "Your name" }),
      "Ola",
    );
    await post(user);
    expect(lastAuthor()).toBe("Ola");

    await typeComment(user, "Two");
    await post(user);
    expect(createComment).toHaveBeenCalledTimes(2);
    expect(lastAuthor()).toBe("Ola");
  });

  it("the host on a phone is never asked for a name", async () => {
    const user = userEvent.setup();
    openHost();
    await typeComment(user, "Note to self");
    await post(user);
    expect(
      within(dock()).queryByRole("textbox", { name: "Your name" }),
    ).toBeNull();
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(lastAuthor()).toBe("Host");
  });
});
