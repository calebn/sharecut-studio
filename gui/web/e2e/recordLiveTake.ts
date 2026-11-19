import {
  type Browser,
  type BrowserContextOptions,
  devices,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  type KeeperRef,
  keeperSegmentWavBytes,
  ONE_SECOND_KEEPER_WAV_BYTES,
} from "./keeperOpfs";
import { installNetworkOutage, type NetworkOutage } from "./networkOutage";
import {
  clickHostTransport,
  createRecordRoom,
  joinAsGuest,
  markSharecutE2e,
  openHostRecordRoom,
  recordParticipantId,
  roomPill,
} from "./recordRoom";
import { switchE2eProject, withShareableProject } from "./shareableProject";
import { openProject } from "./stageNav";
import { withBrowserPages } from "./twoBrowserPages";

export const LAPTOP: BrowserContextOptions = {
  viewport: { width: 1280, height: 800 },
  screen: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
};

const { defaultBrowserType: _iphoneBrowser, ...iPhone } = devices["iPhone 13"];
export const PHONE: BrowserContextOptions = { ...iPhone, deviceScaleFactor: 2 };

export const LIVE_PILL = /^\d+:\d{2} · Take \d+$/;

export type LiveTake = {
  host: Page;
  guest: Page;
  projectPath: string;
  roomDlg: Locator;
  hostNet: NetworkOutage;
  guestNet: NetworkOutage;
  guestId: string;
  guestKeeper: KeeperRef;
  room: Awaited<ReturnType<typeof createRecordRoom>>;
};

export async function withLiveTake(
  browser: Browser,
  guestOptions: BrowserContextOptions,
  run: (take: LiveTake) => Promise<void>,
): Promise<void> {
  await withShareableProject(async (projectPath) => {
    await withBrowserPages(browser, [LAPTOP, guestOptions], async (pages) => {
      const [host, guest] = pages as [Page, Page];
      await markSharecutE2e(host);
      const hostNet = await installNetworkOutage(host, {
        webSocket: /\/api\/host\/ws/,
      });
      await openProject(host, projectPath, { query: "&e2e=1" });
      await expect(host.getByRole("heading", { level: 1 })).toBeVisible();
      const room = await createRecordRoom(host, projectPath);
      const roomDlg = await openHostRecordRoom(host);

      await markSharecutE2e(guest);
      const guestNet = await installNetworkOutage(guest, {
        webSocket: /\/api\/rec\/[^/]+\/ws/,
        http: (url) => url.pathname.startsWith("/api/rec/"),
      });
      await joinAsGuest(guest, room.guest.token, "Ava");
      const guestId = await recordParticipantId(host, projectPath, "Ava");
      const guestKeeper: KeeperRef = {
        sessionId: room.session_id,
        takeIndex: 0,
        participantId: guestId,
      };

      await clickHostTransport(
        host,
        roomDlg.getByRole("button", { name: "Record", exact: true }),
        projectPath,
        "Start",
        "recording",
      );
      await expect(roomPill(guest)).toHaveText(/^\d+:\d{2} · Take \d+$/);
      await expect
        .poll(() => keeperSegmentWavBytes(guest, guestKeeper, 0), {
          timeout: 30_000,
        })
        .toBeGreaterThan(ONE_SECOND_KEEPER_WAV_BYTES);

      await run({
        host,
        guest,
        projectPath,
        roomDlg,
        hostNet,
        guestNet,
        guestId,
        guestKeeper,
        room,
      });
    });
  }, switchE2eProject);
}

export async function boxOf(locator: Locator) {
  const found = await locator.boundingBox();
  expect(found).not.toBeNull();
  return found as NonNullable<typeof found>;
}
