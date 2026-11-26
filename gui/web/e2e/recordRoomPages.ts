import fs from "node:fs";
import {
  type Browser,
  type BrowserContextOptions,
  devices,
  expect,
  type Page,
} from "@playwright/test";
import { createRelocatedE2eProject } from "./liveProject";
import {
  createRecordRoom,
  joinAsGuest,
  markSharecutE2e,
  openHostRecordRoom,
} from "./recordRoom";
import { switchE2eProject, withShareableProject } from "./shareableProject";
import { openProject } from "./stageNav";
import { withBrowserPages } from "./twoBrowserPages";

const { defaultBrowserType: _iphoneBrowser, ...iPhone } = devices["iPhone 13"];

export const phoneAt = (
  width: number,
  height = 844,
): BrowserContextOptions => ({
  ...iPhone,
  viewport: { width, height },
});

export const LAPTOP: BrowserContextOptions = {
  viewport: { width: 1280, height: 800 },
  screen: { width: 1280, height: 800 },
};

function titledProject(title: string) {
  return (prefix: string) => {
    const created = createRelocatedE2eProject(prefix);
    const project = JSON.parse(fs.readFileSync(created.projectPath, "utf8"));
    project.meta = { ...project.meta, name: title };
    fs.writeFileSync(created.projectPath, JSON.stringify(project, null, 2));
    return created;
  };
}

/** A host page with a record room open and a second page for the guest; the caller joins. */
export async function inRoom(
  browser: Browser,
  options: {
    guest?: BrowserContextOptions;
    host?: BrowserContextOptions;
    /** Other guests who join first, so the room holds the host, them and the viewer. */
    crowd?: string[];
    title?: string;
  },
  run: (ctx: {
    host: Page;
    guest: Page;
    projectPath: string;
    room: Awaited<ReturnType<typeof createRecordRoom>>;
  }) => Promise<void>,
) {
  await withShareableProject(
    async (projectPath) => {
      await withBrowserPages(
        browser,
        [
          options.host ?? LAPTOP,
          options.guest ?? phoneAt(390),
          ...(options.crowd ?? []).map(() => LAPTOP),
        ],
        async ([host, guest, ...others]) => {
          await markSharecutE2e(host!);
          await openProject(host!, projectPath, { query: "&e2e=1" });
          await expect(host!.getByRole("heading", { level: 1 })).toBeVisible();
          const room = await createRecordRoom(host!, projectPath);
          await openHostRecordRoom(host!);
          await markSharecutE2e(guest!);
          for (const [index, name] of (options.crowd ?? []).entries()) {
            await markSharecutE2e(others[index]!);
            await joinAsGuest(others[index]!, room.guest.token, name);
          }
          await run({ host: host!, guest: guest!, projectPath, room });
        },
      );
    },
    switchE2eProject,
    options.title ? titledProject(options.title) : undefined,
  );
}
