import type { Page, TestInfo } from "@playwright/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectPageAxeClean, expectReadingSurfaceAxeClean } from "./axe";
import { checkMixGeometry } from "./phoneMix";
import {
  type BrowserName,
  ownsStudioAxe,
  type StudioAxeOwnership,
} from "./studioAxeOwnership";

const scans = vi.hoisted(() => ({
  analyzed: vi.fn(),
  disabled: vi.fn(),
  included: vi.fn(),
  violations: [] as { id: string }[],
}));

vi.mock("@axe-core/playwright", () => ({
  AxeBuilder: class {
    disableRules(rules: string[]) {
      scans.disabled(rules);
      return this;
    }
    include(selector: string) {
      scans.included(selector);
      return this;
    }
    async analyze() {
      scans.analyzed();
      return { violations: scans.violations };
    }
  },
}));
vi.mock("@playwright/test", async () => {
  const { expect } = await import("vitest");
  return { expect };
});

const engines: BrowserName[] = ["chromium", "webkit", "firefox"];
const owners: { owner: StudioAxeOwnership; scans: number }[] = [
  { owner: { suite: "main" }, scans: 1 },
  { owner: { suite: "compat", engine: "chromium" }, scans: 0 },
  { owner: { suite: "compat", engine: "webkit" }, scans: 1 },
  { owner: { suite: "compat", engine: "firefox" }, scans: 0 },
];

beforeEach(() => {
  vi.clearAllMocks();
  scans.violations = [];
});

describe("Studio axe ownership", () => {
  it("retains every main scan", () => {
    expect(ownsStudioAxe({ suite: "main" })).toBe(true);
  });

  it.each(engines)("selects the compat engine %s", (engine) => {
    expect(ownsStudioAxe({ suite: "compat", engine })).toBe(
      engine === "webkit",
    );
  });

  it("keeps branded Chrome under Chromium ownership", () => {
    const browserName: BrowserName = "chromium";
    expect(ownsStudioAxe({ suite: "compat", engine: browserName })).toBe(false);
  });
});

function geometryFixture() {
  const row = {
    scrollIntoViewIfNeeded: vi.fn(),
    boundingBox: async () => ({ y: 0, height: 56 }),
  };
  const mix = {
    evaluate: async () => ({
      documentWidth: 360,
      viewportWidth: 360,
      mixScrollWidth: 360,
      mixWidth: 360,
      sheetBottom: 700,
      navTop: 700,
      rows: [56],
      targets: [{ width: 44, height: 44 }],
    }),
    getByRole: () => ({ last: () => row }),
  };
  const page = {
    getByRole: () => mix,
    locator: () => ({ boundingBox: async () => ({ y: 0, height: 700 }) }),
    screenshot: vi.fn(),
  } as unknown as Page;
  const info = {
    attach: vi.fn(),
    outputPath: () => "mix.png",
  } as unknown as TestInfo;
  return { page, info, row };
}

describe("shared Mix acceptance", () => {
  it.each(owners)(
    "runs real scans for $owner and retains geometry evidence",
    async ({ owner, scans: count }) => {
      const { page, info, row } = geometryFixture();
      await checkMixGeometry(page, info, owner);
      expect(scans.analyzed).toHaveBeenCalledTimes(count);
      expect(row.scrollIntoViewIfNeeded).toHaveBeenCalledOnce();
      expect(info.attach).toHaveBeenCalledWith(
        "mix-geometry",
        expect.any(Object),
      );
      expect(page.screenshot).toHaveBeenCalledOnce();
    },
  );

  it.each(owners.filter(({ scans }) => scans))(
    "fails $owner when its scan reports a violation",
    async ({ owner }) => {
      scans.violations = [{ id: "button-name" }];
      const { page, info } = geometryFixture();
      await expect(checkMixGeometry(page, info, owner)).rejects.toThrow(
        "button-name",
      );
      expect(scans.analyzed).toHaveBeenCalledOnce();
    },
  );
});

describe("generic axe helpers", () => {
  const page = {} as Page;

  it("still scans Studio with its existing rules and selector", async () => {
    await expectPageAxeClean(page, ".studio-panel");
    expect(scans.analyzed).toHaveBeenCalledOnce();
    expect(scans.disabled).toHaveBeenCalledWith(["color-contrast", "region"]);
    expect(scans.included).toHaveBeenCalledWith(".studio-panel");
  });

  it("scans reading surfaces with all rules", async () => {
    await expectReadingSurfaceAxeClean(page);
    expect(scans.analyzed).toHaveBeenCalledOnce();
    expect(scans.disabled).not.toHaveBeenCalled();
    expect(scans.included).not.toHaveBeenCalled();
  });

  it.each([expectPageAxeClean, expectReadingSurfaceAxeClean])(
    "rejects violations through %s",
    async (scan) => {
      scans.violations = [{ id: "button-name" }];
      await expect(scan(page)).rejects.toThrow("button-name");
      expect(scans.analyzed).toHaveBeenCalledOnce();
    },
  );
});
