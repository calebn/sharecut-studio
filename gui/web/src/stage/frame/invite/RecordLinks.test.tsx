import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { shareOptionsFixture } from "../../../stages/deliver/shareFixture";
import { ONLINE_SHARING_GUIDE_URL } from "../../../stages/deliver/tunnelStatusCopy";
import { hostShareRow } from "../../../test/fixtures";
import type { TunnelStatus } from "../../../types/tunnel";
import { InviteBody } from "./InviteBody";

const tunnel = (state: TunnelStatus["state"]): TunnelStatus => ({
  state,
  reason: null,
  reason_kind: null,
  relay_host: "relay.example.test",
  public_base_url: "https://share.example.test",
  share_count: 1,
  retry_at: null,
});

const LOCAL = "http://127.0.0.1:8080/rec";
const PUBLIC = "https://share.example.app/rec";

const rows = (base: string, sessionId = "room-1", closed = false) => [
  hostShareRow({
    token: `${sessionId}-g`,
    url: `${base}/${sessionId}-g`,
    kind: "record",
    docs_role: null,
    record_role: "guest",
    session_id: sessionId,
    invite_closed: closed,
  }),
  hostShareRow({
    token: `${sessionId}-p`,
    url: `${base}/${sessionId}-p`,
    kind: "record",
    docs_role: null,
    record_role: "producer",
    session_id: sessionId,
    invite_closed: closed,
  }),
];

const renderRooms = (
  over: Parameters<typeof shareOptionsFixture>[0],
  props: { rows: ReturnType<typeof rows> },
) =>
  render(<InviteBody options={shareOptionsFixture({ ...props, ...over })} />);

const copyButtons = () =>
  screen
    .getAllByRole("button", { name: /^Copy (guest|producer) link$/ })
    .filter((b) => !b.hasAttribute("aria-disabled"));

const noteOf = () => screen.queryByText(/so only people on this network/);

const describedIds = (button: HTMLElement) =>
  (button.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);

describe("Record room local-only note", () => {
  it("[FAILS-OLD] says the room is not set up for online sharing and links the guide", () => {
    renderRooms({ tunnel: tunnel("not_set_up") }, { rows: rows(LOCAL) });
    expect(
      screen.getByText(
        /Online sharing isn't set up on this computer, so only people on this network can open these links\. Turn on online sharing to invite anyone\./,
      ),
    ).toBeVisible();
    const guide = screen.getByRole("link", {
      name: /How to turn on online sharing/,
    });
    expect(guide).toHaveAttribute("href", ONLINE_SHARING_GUIDE_URL);
    expect(guide).toHaveAttribute("target", "_blank");
  });

  it("[FAILS-OLD] says the same when no online sharing feature answered", () => {
    renderRooms({ tunnel: null }, { rows: rows(LOCAL) });
    expect(screen.getByText(/isn't set up on this computer/)).toBeVisible();
  });

  it("[FAILS-OLD] says online sharing is off when the tunnel is off", () => {
    renderRooms({ tunnel: tunnel("off") }, { rows: rows(PUBLIC) });
    expect(
      screen.getByText(/Online sharing is off, so only people on this network/),
    ).toBeVisible();
  });

  it("[FAILS-OLD] ties both Copy buttons to the note, and the note exists", () => {
    renderRooms({ tunnel: tunnel("not_set_up") }, { rows: rows(LOCAL) });
    const note = noteOf()?.closest("p");
    expect(note).toBeTruthy();
    const buttons = copyButtons();
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(describedIds(button)).toContain(note?.id);
    }
  });

  it.each([
    "online",
    "limited",
    "connecting",
    "reconnecting",
    "offline",
  ] as const)(
    "[GUARD] no note while online sharing is %s, and no dangling id",
    (state) => {
      renderRooms({ tunnel: tunnel(state) }, { rows: rows(LOCAL) });
      expect(noteOf()).toBeNull();
      expectDescribedIdsExist();
    },
  );

  it("[GUARD] no note for public addresses with no online sharing feature", () => {
    renderRooms({ tunnel: null }, { rows: rows(PUBLIC) });
    expect(noteOf()).toBeNull();
    expectDescribedIdsExist();
  });

  it("[GUARD] no note when every invite is closed, and the closed Copy has no dangling id", () => {
    renderRooms(
      { tunnel: tunnel("not_set_up") },
      { rows: rows(LOCAL, "room-1", true) },
    );
    expect(noteOf()).toBeNull();
    expectDescribedIdsExist();
  });

  it("[FAILS-OLD] shows the note when one invite is closed and one is open", () => {
    const [guest, producer] = rows(LOCAL);
    renderRooms(
      { tunnel: tunnel("not_set_up") },
      {
        rows: [
          { ...(guest as NonNullable<typeof guest>), invite_closed: true },
          producer as NonNullable<typeof producer>,
        ],
      },
    );
    expect(noteOf()).toBeVisible();
    expectDescribedIdsExist();
  });

  it("[FAILS-OLD] gives each local room its own note", () => {
    renderRooms(
      { tunnel: tunnel("not_set_up") },
      { rows: [...rows(LOCAL, "room-1"), ...rows(LOCAL, "room-2")] },
    );
    expect(screen.getAllByText(/so only people on this network/)).toHaveLength(
      2,
    );
  });

  it("[GUARD] says nothing while the status is still being read", () => {
    renderRooms({ tunnel: null, tunnelPending: true }, { rows: rows(LOCAL) });
    expect(noteOf()).toBeNull();
    expect(screen.queryByText(/isn't set up/)).toBeNull();
    expectDescribedIdsExist();
  });

  it("[FAILS-OLD] describes only the Copy of a row that is itself local-only", () => {
    const [guest, producer] = rows(LOCAL);
    renderRooms(
      { tunnel: null },
      {
        rows: [
          guest as NonNullable<typeof guest>,
          {
            ...(producer as NonNullable<typeof producer>),
            url: `${PUBLIC}/room-1-p`,
          },
        ],
      },
    );
    const note = noteOf()?.closest("p");
    const guestCopy = screen.getByRole("button", { name: "Copy guest link" });
    const producerCopy = screen.getByRole("button", {
      name: "Copy producer link",
    });
    expect(describedIds(guestCopy)).toContain(note?.id);
    expect(describedIds(producerCopy)).not.toContain(note?.id);
    expectDescribedIdsExist();
  });

  it("[GUARD] leaves the Review and Listen groups as they were", () => {
    const review = hostShareRow({ token: "rv-1" });
    const listen = hostShareRow({
      token: "ls-1",
      docs_role: "viewer",
      follow_latest: false,
    });
    renderRooms(
      { tunnel: tunnel("not_set_up") },
      { rows: [review, listen, ...rows(LOCAL)] },
    );
    for (const name of ["Review links", "Listen link"]) {
      const group = screen.getByRole("heading", { name }).closest("section");
      expect(group).toBeTruthy();
      expect(
        within(group as HTMLElement).queryByText(
          /so only people on this network can open these links/,
        ),
      ).toBeNull();
    }
    expect(screen.getAllByText(/so only people on this network/)).toHaveLength(
      1,
    );
  });

  it("[GUARD] Copy still copies the row address", async () => {
    const onCopy = vi.fn();
    renderRooms(
      { tunnel: tunnel("not_set_up"), onCopy },
      { rows: rows(LOCAL) },
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Copy guest link" }),
    );
    expect(onCopy).toHaveBeenCalledWith(
      "link",
      "room-1-g",
      expect.any(String),
      `${LOCAL}/room-1-g`,
    );
  });
});

function expectDescribedIdsExist() {
  const buttons = screen.getAllByRole("button", {
    name: /^Copy (guest|producer) link$/,
  });
  expect(buttons.length).toBeGreaterThan(0);
  for (const button of buttons) {
    const ids = describedIds(button);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(document.getElementById(id)).not.toBeNull();
  }
}
