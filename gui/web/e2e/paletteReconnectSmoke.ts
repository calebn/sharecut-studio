import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  test as base,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import { AUTO_MIX_PREF_KEY } from "../src/hooks/autoMixPref";
import { disambiguatedNames } from "../src/presence/colors";
import {
  applyPresenceDelta,
  rosterFromList,
  type SessionRoster,
} from "../src/presence/roster";
import type { SessionClient } from "../src/types/session";
import { e2eBaseURL } from "./env";
import { followPill, openPeopleMenu } from "./follow";
import { installNetworkOutage } from "./networkOutage";
import {
  installFollowerWireProbe,
  readFollowerWire,
} from "./paletteFollowerProbe";
import { createPaletteReconnectProject } from "./paletteReconnectProject";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { goToStage, openProjectDialog, phone } from "./stageNav";
import { withBrowserPages } from "./twoBrowserPages";

const test = base.extend({ trace: "off", screenshot: "off", video: "off" });

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const mode: string = "head";

type Frame = {
  type?: string;
  plane?: string;
  client_id?: string;
  clients?: SessionClient[];
  roster_version?: number;
  author_client_id?: string;
  changes?: Parameters<typeof applyPresenceDelta>[3];
  snapshot?: { clients?: SessionClient[]; roster_version?: number };
  playhead_sec?: number | null;
  meta?: SessionClient["meta"];
};
type Probe = ReturnType<typeof observe>;

function inconclusive(reason: string): never {
  throw new Error(`INCONCLUSIVE: ${reason}`);
}

type ObservedSocket = {
  id: number;
  role: "host" | "guest";
  closed: boolean;
  closeSequence: number | null;
  helloSequence: number | null;
};
type SentPresence = { socketId: number; sequence: number; frame: Frame };

function observe(page: Page) {
  const state = {
    clientId: "",
    roster: Object.create(null) as SessionRoster,
    version: 0,
    rosterFrames: 0,
    documentFrames: 0,
    sequence: 0,
    currentSocketId: 0,
    sockets: [] as ObservedSocket[],
    uncertain: false,
    sent: [] as SentPresence[],
    cursorUpdates: new Map<string, number>(),
  };
  const acceptRoster = (roster: SessionRoster, version: number) => {
    for (const [id, row] of Object.entries(roster)) {
      const before = state.roster[id];
      if (
        before &&
        JSON.stringify(row.meta?.cursor) !== JSON.stringify(before.meta?.cursor)
      ) {
        state.cursorUpdates.set(id, (state.cursorUpdates.get(id) ?? 0) + 1);
      }
    }
    state.roster = roster;
    state.version = version;
  };
  page.on("websocket", (socket) => {
    const url = new URL(socket.url());
    if (!/\/daw\/ws$|^\/api\/host\/ws$/.test(url.pathname)) return;
    const connection: ObservedSocket = {
      id: state.sockets.length + 1,
      role: url.pathname === "/api/host/ws" ? "host" : "guest",
      closed: false,
      closeSequence: null,
      helloSequence: null,
    };
    if (state.sockets.some((entry) => !entry.closed)) state.uncertain = true;
    state.sockets.push(connection);
    state.currentSocketId = connection.id;
    if (connection.role === "host")
      state.clientId = url.searchParams.get("client_id") ?? "";
    socket.on("close", () => {
      connection.closed = true;
      connection.closeSequence = ++state.sequence;
    });
    socket.on("framesent", ({ payload }) => {
      const sequence = ++state.sequence;
      try {
        const frame = JSON.parse(String(payload)) as Frame;
        if (frame.type === "Presence") {
          state.sent.push({
            socketId: connection.id,
            sequence,
            frame: {
              type: frame.type,
              playhead_sec: frame.playhead_sec,
              meta: frame.meta,
            },
          });
        }
      } catch {
        state.uncertain = true;
      }
    });
    socket.on("framereceived", ({ payload }) => {
      const sequence = ++state.sequence;
      if (connection.closed || state.currentSocketId !== connection.id) return;
      let frame: Frame;
      try {
        frame = JSON.parse(String(payload)) as Frame;
      } catch {
        state.uncertain = true;
        return;
      }
      if (!frame || typeof frame !== "object") return;
      if (frame.plane === "document") state.documentFrames++;
      if (
        connection.role === "guest" &&
        frame.plane === "session" &&
        frame.client_id
      ) {
        state.clientId = frame.client_id;
      }
      if (
        frame.plane === "session" &&
        frame.type === "Snapshot" &&
        frame.snapshot &&
        (connection.role === "host" || !!frame.client_id)
      ) {
        connection.helloSequence = sequence;
      }
      if (connection.role === "host" && frame.plane !== "session") return;
      if (frame.type === "Presence" && Array.isArray(frame.clients)) {
        state.rosterFrames++;
        if (
          typeof frame.roster_version === "number" &&
          frame.roster_version < state.version
        )
          return;
        acceptRoster(
          rosterFromList(frame.clients, state.roster),
          frame.roster_version ?? state.version,
        );
      } else if (frame.type === "PresenceDelta") {
        state.rosterFrames++;
        if (typeof frame.author_client_id !== "string" || !frame.changes)
          return;
        const next = applyPresenceDelta(
          state.roster,
          state.version,
          frame.author_client_id,
          frame.changes,
          frame.roster_version ?? 0,
        );
        if (next.outcome === "applied") acceptRoster(next.roster, next.version);
        if (next.outcome === "resync") state.uncertain = true;
      } else if (frame.type === "PresenceResync") {
        state.rosterFrames++;
        state.uncertain = true;
      } else if (
        ["Snapshot", "Applied", "Echo"].includes(frame.type ?? "") &&
        Array.isArray(frame.snapshot?.clients)
      ) {
        state.rosterFrames++;
        acceptRoster(
          rosterFromList(frame.snapshot.clients, state.roster),
          frame.snapshot.roster_version ?? state.version,
        );
      } else if (
        Array.isArray(frame.clients) ||
        Array.isArray(frame.snapshot?.clients)
      ) {
        state.rosterFrames++;
        state.uncertain = true;
      }
    });
  });
  return state;
}

function noPlayhead(row: SessionClient | undefined): boolean {
  return (
    !!row &&
    !Number.isFinite(row.playhead_sec) &&
    !Number.isFinite(row.meta?.transport?.playhead_sec)
  );
}

function requiredPeer(probe: Probe, id: string): SessionClient {
  const peer = probe.roster[id];
  if (probe.uncertain || !peer)
    inconclusive(
      "passive roster evidence is incomplete or the identified peer is absent",
    );
  return peer;
}

function peerName(probe: Probe, id: string): string {
  const others = Object.values(probe.roster).filter(
    (row) => row.client_id !== probe.clientId,
  );
  const name = disambiguatedNames(others).get(id);
  if (
    !name ||
    [...disambiguatedNames(others).values()].filter((value) => value === name)
      .length !== 1
  ) {
    inconclusive("real roster does not identify one unique rendered peer name");
  }
  return name;
}

function counters(probe: Probe) {
  return {
    rosterFrames: probe.rosterFrames,
    documentFrames: probe.documentFrames,
  };
}

async function unchangedDuring(
  probe: Probe,
  page: Page,
  action: () => Promise<void>,
) {
  const before = {
    counters: counters(probe),
    roster: JSON.stringify(probe.roster),
    url: page.url(),
  };
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  if (
    JSON.stringify(counters(probe)) !== JSON.stringify(before.counters) ||
    JSON.stringify(probe.roster) !== before.roster ||
    page.url() !== before.url ||
    probe.uncertain
  ) {
    inconclusive(
      "an inbound roster/document frame or project navigation overlapped the critical resize",
    );
  }
  if (failure) throw failure;
}

function palette(page: Page) {
  return page.getByRole("dialog", {
    name: "Commands and shortcuts",
    exact: true,
  });
}

function rowsFor(page: Page, name: string): Locator {
  return palette(page)
    .getByRole("group", { name: "People", exact: true })
    .getByRole("option")
    .filter({
      has: page.locator(".command-palette-label").filter({
        hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
      }),
    });
}

async function searchPeer(page: Page, name: string) {
  await openProjectDialog(page, "palette");
  const input = palette(page).getByRole("combobox", {
    name: "Search commands",
  });
  await input.fill(name);
  return input;
}

async function selectVerb(page: Page, name: string, verb: "Follow" | "Go to") {
  const input = palette(page).getByRole("combobox", {
    name: "Search commands",
  });
  const count = await palette(page).getByRole("option").count();
  for (let i = 0; i <= count; i++) {
    if (
      (await palette(page).getByRole("status").textContent())?.endsWith(
        `Enter: ${verb} ${name}`,
      )
    ) {
      const id = await input.getAttribute("aria-activedescendant");
      if (!id)
        throw new Error("selected palette action has no active descendant");
      await expect(page.locator(`[id=${JSON.stringify(id)}]`)).toHaveAttribute(
        "aria-selected",
        "true",
      );
      return id;
    }
    await input.press("ArrowDown");
  }
  throw new Error(
    `real palette has no selectable ${verb} action for identified peer`,
  );
}

export function registerPaletteReconnectSmoke() {
  test.describe("real palette reconnect", () => {
    test.describe.configure({ retries: 0 });
    test("real reconnect keeps palette actions current while open", async ({
      browser,
    }, testInfo) => {
      test.setTimeout(180_000);
      const secrets: string[] = [];
      const receipt: Record<string, unknown> = {
        mode,
        outcome: "NOT_EXECUTED",
      };
      try {
        const version = browser.version();
        const executable = browser.browserType().executablePath();
        if (
          version !== "158.0.8127.18" ||
          !/(?:chromium|chromium_headless_shell)-1254\//.test(executable)
        ) {
          inconclusive(
            "requires locked Chromium1254 Chrome for Testing158.0.8127.18",
          );
        }
        Object.assign(receipt, {
          browserVersion: version,
          browserRevision: 1254,
          fixtureSha256: createHash("sha256")
            .update(
              fs.readFileSync(
                new URL(
                  "./fixtures/palette-reconnect.sharecut",
                  import.meta.url,
                ),
              ),
            )
            .digest("hex"),
        });
        await withShareableProject(
          async (projectPath) => {
            await withBrowserPages(
              browser,
              [PHONE, PHONE, DESKTOP].map((viewport) => ({
                viewport,
                storageState: {
                  cookies: [],
                  origins: [
                    {
                      origin: new URL(e2eBaseURL).origin,
                      localStorage: [{ name: AUTO_MIX_PREF_KEY, value: "off" }],
                    },
                  ],
                },
              })),
              async ([host, follower, observer]) => {
                if (!host || !follower || !observer)
                  throw new Error("three isolated pages are required");
                const hostProbe = observe(host);
                await installFollowerWireProbe(follower);
                const outage = await installNetworkOutage(follower, {
                  webSocket: /\/api\/review\/[^/]+\/daw\/ws/,
                });
                const observerProbe = observe(observer);
                await openHostShare(host, projectPath);
                await phone.showTimeline(host);
                const ruler = host.getByRole("slider", {
                  name: "Timeline position",
                });
                await ruler.focus();
                await ruler.press("End");
                await phone.showText(host);
                const followerToken = await createReviewShare(
                  host,
                  projectPath,
                  "editor",
                );
                secrets.push(followerToken);
                const observerToken = await createReviewShare(
                  host,
                  projectPath,
                  "editor",
                );
                secrets.push(observerToken);
                await openGuestShare(follower, followerToken);
                const followerRoleHint = follower
                  .locator(".stage-frame-header")
                  .getByRole("note")
                  .filter({
                    hasText:
                      "You can edit and comment. The host decides what ships.",
                  });
                await expect(followerRoleHint).toBeVisible();
                await followerRoleHint
                  .getByRole("button", { name: "Dismiss hint", exact: true })
                  .click();
                await expect(followerRoleHint).toBeHidden();
                await phone.showText(follower);
                await openGuestShare(observer, observerToken);
                const observerRoleHint = observer
                  .locator(".stage-frame-header")
                  .getByRole("note")
                  .filter({
                    hasText:
                      "You can edit and comment. The host decides what ships.",
                  });
                await expect(observerRoleHint).toBeVisible();
                await observerRoleHint
                  .getByRole("button", { name: "Dismiss hint", exact: true })
                  .click();
                await expect(observerRoleHint).toBeHidden();
                await goToStage(observer, "edit");
                await expect
                  .poll(
                    async () =>
                      !!(await readFollowerWire(follower)).clientId &&
                      !!observerProbe.clientId &&
                      !!hostProbe.clientId,
                  )
                  .toBe(true);
                const { leaderId, followerId, leaderName } =
                  await test.step("3940:61", async () => {
                    const leaderId = hostProbe.clientId;
                    const followerId = (await readFollowerWire(follower))
                      .clientId;
                    const leaderName = peerName(observerProbe, leaderId);
                    return { leaderId, followerId, leaderName };
                  });
                const menu = await test.step("3940:62", async () => {
                  const face = follower.locator(
                    `.avatar-header .avatar-face[data-person=${JSON.stringify(leaderId)}]`,
                  );
                  await expect(face).toHaveCount(1);
                  const menu = await openPeopleMenu(follower, face);
                  return menu;
                });
                await test.step("3940:63", async () => {
                  await menu
                    .getByRole("menuitem", { name: "Follow", exact: true })
                    .click();
                });
                await test.step("3940:64", async () => {
                  await expect(followPill(follower)).toContainText(
                    `Following ${leaderName}`,
                  );
                });
                await test.step("3940:65", async () => {
                  await expect
                    .poll(async () =>
                      (await readFollowerWire(follower)).sent.some(
                        ({ frame }) => frame.meta?.following === leaderId,
                      ),
                    )
                    .toBe(true);
                });
                const old = await test.step("3940:66", async () => {
                  const before = await readFollowerWire(follower);
                  const old = before.sockets.at(-1);
                  if (!old || old.closed || old.helloSequence === null)
                    inconclusive("no actual live follower socket with hello");
                  return old;
                });
                await outage.drop();
                try {
                  await expect
                    .poll(
                      async () =>
                        (await readFollowerWire(follower)).sockets.find(
                          (s) => s.id === old.id,
                        )?.closed,
                    )
                    .toBe(true);
                  await expect
                    .poll(() => !observerProbe.roster[followerId])
                    .toBe(true);
                } catch {
                  inconclusive(
                    "outage did not produce actual browser close and server roster removal",
                  );
                } finally {
                  outage.restore();
                }
                try {
                  await expect
                    .poll(
                      async () => {
                        const wire = await readFollowerWire(follower);
                        const closed = wire.sockets.find(
                          (s) => s.id === old.id,
                        );
                        const active = wire.sockets.at(-1);
                        const row = observerProbe.roster[followerId];
                        return (
                          !wire.uncertain &&
                          wire.clientId === followerId &&
                          active &&
                          !active.closed &&
                          active.id > old.id &&
                          active.helloSequence !== null &&
                          closed?.closeSequence !== null &&
                          active.helloSequence >
                            (closed?.closeSequence ?? Infinity) &&
                          wire.sent.some(
                            ({ socketId, sequence, frame }) =>
                              socketId === active.id &&
                              sequence > (active.helloSequence ?? Infinity) &&
                              frame.meta?.following === leaderId &&
                              !Number.isFinite(frame.playhead_sec) &&
                              !Number.isFinite(
                                frame.meta?.transport?.playhead_sec,
                              ),
                          ) &&
                          noPlayhead(row) &&
                          row?.meta?.following === leaderId &&
                          row?.meta?.ui?.tab === "transcript" &&
                          row?.meta?.ui?.mobile_mode === "text"
                        );
                      },
                      { timeout: 20_000 },
                    )
                    .toBe(true);
                } catch {
                  inconclusive(
                    "real reconnect did not yield preserved follow and independently observed no-playhead text row",
                  );
                }
                const rejoined = await readFollowerWire(follower);
                await expect(followPill(follower)).toContainText(
                  `Following ${leaderName}`,
                );
                const peer = requiredPeer(observerProbe, followerId);
                const name = peerName(observerProbe, followerId);
                const leader = requiredPeer(observerProbe, leaderId);
                if (
                  !Number.isFinite(leader.playhead_sec) &&
                  !Number.isFinite(leader.meta?.transport?.playhead_sec)
                )
                  inconclusive("finite-playhead leader control is absent");
                Object.assign(receipt, {
                  followerId,
                  leaderId,
                  observerId: observerProbe.clientId,
                  actualName: name,
                  follower: peer,
                  reconnect: { oldSocketId: old.id, wire: rejoined },
                });
                await observer.setViewportSize(PHONE);
                await phone.showTimeline(observer);
                await expect(
                  observer.locator('.phone-edit[data-surface="lanes"]'),
                ).toBeVisible();
                await expect(
                  observer.locator('.phone-edit[data-surface="text"]'),
                ).toBeHidden();
                await observer.setViewportSize(DESKTOP);
                let input = await searchPeer(
                  observer,
                  peerName(observerProbe, leaderId),
                );
                await selectVerb(
                  observer,
                  peerName(observerProbe, leaderId),
                  "Go to",
                );
                await input.press("Escape");
                input = await searchPeer(observer, name);
                await expect(rowsFor(observer, name)).toHaveCount(1);
                let selectedFollowId = await selectVerb(
                  observer,
                  name,
                  "Follow",
                );
                let dialogNode = await palette(observer).elementHandle();
                if (!dialogNode) throw new Error("palette is not mounted");
                const retainFollow = async () => {
                  if (!dialogNode) throw new Error("palette is not mounted");
                  expect(
                    await dialogNode.evaluate((node) => node.isConnected),
                  ).toBe(true);
                  expect(
                    await palette(observer).evaluate(
                      (node, original) => node === original,
                      dialogNode,
                    ),
                  ).toBe(true);
                  await expect(input).toHaveValue(name);
                  await expect(input).toHaveAttribute(
                    "aria-activedescendant",
                    selectedFollowId,
                  );
                  await expect(
                    palette(observer).getByRole("status"),
                  ).toContainText(`Enter: Follow ${name}`);
                  await expect(
                    observer.locator(
                      `[id=${JSON.stringify(selectedFollowId)}]`,
                    ),
                  ).toHaveAttribute("aria-selected", "true");
                };
                const reopen = async (count: number) => {
                  await input.press("Escape");
                  input = await searchPeer(observer, name);
                  await expect(rowsFor(observer, name)).toHaveCount(count);
                  selectedFollowId = await selectVerb(observer, name, "Follow");
                  dialogNode = await palette(observer).elementHandle();
                  if (!dialogNode)
                    throw new Error("reopened palette is not mounted");
                };
                await unchangedDuring(observerProbe, observer, async () => {
                  await observer.setViewportSize(PHONE);
                  await expect(observer.locator("html")).toHaveAttribute(
                    "data-shell",
                    "phone",
                  );
                  await expect(input).toHaveValue(name);
                  await expect(rowsFor(observer, name)).toHaveCount(
                    mode === "head" ? 2 : 1,
                  );
                  await retainFollow();
                });
                receipt.criticalResize =
                  "stable raw roster, no inbound roster/document frames, same mounted dialog and project URL";
                if (mode === "parent") {
                  receipt.parentObservedMissingUntilReopen = true;
                  await reopen(2);
                }
                await retainFollow();
                await unchangedDuring(observerProbe, observer, async () => {
                  await observer.setViewportSize(DESKTOP);
                  await expect(observer.locator("html")).not.toHaveAttribute(
                    "data-shell",
                    "phone",
                  );
                  await expect(rowsFor(observer, name)).toHaveCount(
                    mode === "head" ? 1 : 2,
                  );
                  await retainFollow();
                });
                if (mode === "parent") await reopen(1);
                await unchangedDuring(observerProbe, observer, async () => {
                  await observer.setViewportSize(PHONE);
                  await expect(observer.locator("html")).toHaveAttribute(
                    "data-shell",
                    "phone",
                  );
                  await expect(rowsFor(observer, name)).toHaveCount(
                    mode === "head" ? 2 : 1,
                  );
                  await retainFollow();
                });
                if (mode === "parent") await reopen(2);
                const selectedId = await selectVerb(observer, name, "Go to");
                const updateBefore =
                  observerProbe.cursorUpdates.get(leaderId) ?? 0;
                const leaderWords = host.locator(".sys-script-word");
                await expect(leaderWords).toHaveCount(2);
                const firstBox = await leaderWords.first().boundingBox();
                const lastBox = await leaderWords.last().boundingBox();
                if (!firstBox || !lastBox)
                  inconclusive("real leader text targets are not visible");
                await host.mouse.move(
                  firstBox.x + firstBox.width / 2,
                  firstBox.y + firstBox.height / 2,
                );
                await host.mouse.move(
                  lastBox.x + lastBox.width / 2,
                  lastBox.y + lastBox.height / 2,
                  { steps: 3 },
                );
                try {
                  await expect
                    .poll(
                      () => observerProbe.cursorUpdates.get(leaderId) ?? 0,
                      { timeout: 5_000 },
                    )
                    .toBeGreaterThan(updateBefore);
                } catch {
                  inconclusive(
                    "ordinary pointer interaction produced no observed roster update for parent-render retention proof",
                  );
                }
                const destination = requiredPeer(observerProbe, followerId);
                if (
                  !noPlayhead(destination) ||
                  destination.meta?.following !== leaderId ||
                  destination.meta?.ui?.tab !== "transcript" ||
                  destination.meta?.ui?.mobile_mode !== "text"
                ) {
                  inconclusive(
                    "unrelated update changed the destination precondition",
                  );
                }
                await expect(input).toHaveValue(name);
                await expect(input).toHaveAttribute(
                  "aria-activedescendant",
                  selectedId,
                );
                await expect(
                  palette(observer).getByRole("status"),
                ).toContainText(`Enter: Go to ${name}`);
                if (!dialogNode)
                  throw new Error("palette is not mounted before Go to");
                expect(
                  await palette(observer).evaluate(
                    (node, original) => node === original,
                    dialogNode,
                  ),
                ).toBe(true);
                await expect(
                  observer.locator('.phone-edit[data-surface="lanes"]'),
                ).toBeVisible();
                await expect(
                  observer.locator('.phone-edit[data-surface="text"]'),
                ).toBeHidden();
                receipt.navigationBefore =
                  "phone Edit lanes visible, text hidden, Go to selected";
                await input.press("Enter");
                await expect(palette(observer)).toBeHidden();
                await expect(
                  observer.locator('.phone-edit[data-surface="lanes"]'),
                ).toBeHidden();
                await expect(
                  observer.getByRole("main", { name: "Edit", exact: true }),
                ).toBeVisible();
                await expect(
                  observer.locator('.phone-edit[data-surface="text"]'),
                ).toBeVisible();
                await expect(
                  observer.getByRole("region", { name: "Script", exact: true }),
                ).toBeVisible();
                if (observerProbe.uncertain)
                  inconclusive("passive frame attribution became uncertain");
                receipt.outcome =
                  mode === "head" ? "HEAD_PASS" : "PARENT_BUG_REPRODUCED";
              },
            );
          },
          undefined,
          createPaletteReconnectProject,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        receipt.outcome = message.startsWith("INCONCLUSIVE:")
          ? "INCONCLUSIVE"
          : "FAIL";
        let safe = message.replace(
          /https?:\/\/\S+|wss?:\/\/\S+/g,
          "[redacted URL]",
        );
        for (const secret of secrets)
          safe = safe.split(secret).join("[redacted token]");
        receipt.reason = safe;
        throw new Error(safe);
      } finally {
        await testInfo.attach("palette-reconnect-verdict", {
          body: JSON.stringify(receipt, null, 2),
          contentType: "application/json",
        });
      }
    });
  });
}
