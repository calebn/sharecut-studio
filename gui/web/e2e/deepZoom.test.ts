import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatRulerTime } from "../src/utils/time";
import { effectiveMaxZoomPxPerSec } from "../src/utils/timelineZoom.generated";
import {
  expectedLastRulerTick,
  HOUR_SEC,
  offGridPx,
  parseRulerLabel,
  stretchProjectToSession,
} from "./deepZoom";
import { committedE2eProjectPath } from "./env";

describe("parseRulerLabel", () => {
  it("round-trips formatRulerTime", () => {
    for (const sec of [0, 1.5, 59.98, 3599.98, 3600]) {
      for (const step of [0.02, 0.5, 1, 0.0005]) {
        const parsed = parseRulerLabel(formatRulerTime(sec, step));
        // Labels are rounded to the step's decimals, so allow one step.
        expect(Math.abs(parsed - sec)).toBeLessThanOrEqual(step + 1e-9);
      }
    }
  });
  it("parses explicit labels", () => {
    expect(parseRulerLabel("1:00:00.00")).toBe(3600);
    expect(parseRulerLabel("59:59.98")).toBeCloseTo(3599.98, 4);
    expect(parseRulerLabel("0:01.2345")).toBeCloseTo(1.2345, 4);
  });
  it("throws on bad input", () => {
    expect(() => parseRulerLabel("abc")).toThrow();
  });
});

describe("offGridPx", () => {
  it("measures distance to the nearest grid line", () => {
    expect(offGridPx(1024, 512)).toBe(0);
    expect(offGridPx(1023.4, 512)).toBeCloseTo(0.6, 6);
    expect(offGridPx(-1, 512)).toBe(1);
    expect(offGridPx(256, 512)).toBe(256);
  });
});

describe("expectedLastRulerTick", () => {
  it("drops the end label at the ceiling", () => {
    const t = expectedLastRulerTick(
      HOUR_SEC,
      effectiveMaxZoomPxPerSec(HOUR_SEC),
    );
    expect(t.step).toBe(0.02);
    expect(t.label).toBe("59:59.98");
    expect(t.sec).toBeCloseTo(3599.98, 6);
  });
  it("keeps the end label when there is room", () => {
    expect(expectedLastRulerTick(60, 100).label).toBe("1:00");
  });
});

type Clip = { track_id: string; id: string; timeline_start: number };

describe("stretchProjectToSession", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
  function copy(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-zoom-"));
    dirs.push(dir);
    const dest = path.join(dir, "episode.project.json");
    fs.copyFileSync(committedE2eProjectPath, dest);
    return dest;
  }
  it("moves the guest clip and adds an envelope", () => {
    const p = copy();
    const r = stretchProjectToSession(p, HOUR_SEC);
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    const clips = data.timeline.clips as Clip[];
    const guest = clips.find((c) => c.track_id === "guest");
    expect(guest?.timeline_start).toBe(3540);
    expect(data.timeline.duration_sec).toBe(3600);
    expect(clips.find((c) => c.track_id !== "guest")?.timeline_start).toBe(0);
    const env = data.mix.automation_envelopes.filter(
      (e: { track_id: string; parameter: string }) =>
        e.track_id === "guest" && e.parameter === "volume",
    );
    expect(env).toHaveLength(1);
    expect(env[0].points.map((pt: { time: number }) => pt.time)).toEqual([
      3540, 3599.9,
    ]);
    expect(r.trackId).toBe("guest");
    expect(r.clipStartSec).toBe(3540);
    expect(r.endPointSec).toBeCloseTo(3599.9, 6);
  });
  it("throws for an unknown track", () => {
    expect(() => stretchProjectToSession(copy(), HOUR_SEC, "nope")).toThrow();
  });

  it("throws when the track already has a volume envelope", () => {
    const p = copy();
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    data.mix = {
      ...(data.mix ?? {}),
      automation_envelopes: [
        { track_id: "guest", parameter: "volume", points: [] },
      ],
    };
    fs.writeFileSync(p, JSON.stringify(data));
    expect(() => stretchProjectToSession(p, HOUR_SEC)).toThrow(
      /already has a volume envelope/,
    );
  });

  it("throws when the track has more than one clip", () => {
    const p = copy();
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    const guest = (data.timeline.clips as Clip[]).find(
      (c) => c.track_id === "guest",
    );
    data.timeline.clips.push({ ...guest, id: `${guest?.id}_dup` });
    fs.writeFileSync(p, JSON.stringify(data));
    expect(() => stretchProjectToSession(p, HOUR_SEC)).toThrow(/found 2/);
  });
});
