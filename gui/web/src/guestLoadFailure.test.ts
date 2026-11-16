import { describe, expect, it } from "vitest";
import {
  classifyBootstrapFailure,
  type GuestLoadFailure,
  guestLoadCover,
  noAnswerStatus,
} from "./guestLoadFailure";
import { ApiError } from "./utils/apiError";

const SENTINEL = "SENTINEL-body-text-7f3a";

function failure(
  status: number | null,
  code: string | null,
  retryAfterSec: number | null = null,
) {
  return new ApiError(SENTINEL, code, status, null, null, retryAfterSec);
}

describe("classifyBootstrapFailure", () => {
  it.each<[string, unknown, GuestLoadFailure]>([
    [
      "404 share_not_found",
      failure(404, "share_not_found"),
      { kind: "bad-link" },
    ],
    ["404 with no code", failure(404, null), { kind: "bad-link" }],
    [
      "404 project_not_found",
      failure(404, "project_not_found"),
      { kind: "unavailable" },
    ],
    ["network error", failure(null, "network_error"), { kind: "unreachable" }],
    ["502", failure(502, null), { kind: "unreachable" }],
    ["504", failure(504, null), { kind: "unreachable" }],
    ["503 relay", failure(503, null), { kind: "unreachable" }],
    ["503 other code", failure(503, "something_else"), { kind: "unreachable" }],
    ["503 project_busy", failure(503, "project_busy"), { kind: "busy" }],
    [
      "429",
      failure(429, "rate_limited", 12),
      { kind: "rate-limited", retryAfterSec: 12 },
    ],
    [
      "429 without Retry-After",
      failure(429, null),
      { kind: "rate-limited", retryAfterSec: null },
    ],
    ["401", failure(401, "authentication_required"), { kind: "sign-in" }],
    ["403", failure(403, "share_acl_denied"), { kind: "restricted" }],
    ["500 with a code", failure(500, "internal_error"), { kind: "server" }],
    ["500 without one", failure(500, null), { kind: "server" }],
    ["an unknown status", failure(418, "teapot"), { kind: "server" }],
    [
      "an abort",
      new DOMException("aborted", "AbortError"),
      { kind: "unreachable" },
    ],
    ["a plain throw", new Error(SENTINEL), { kind: "unreachable" }],
    ["a TypeError", new TypeError(SENTINEL), { kind: "unreachable" }],
    ["a non-JSON 200", new SyntaxError(SENTINEL), { kind: "intercepted" }],
  ])("reads %s", (_name, error, expected) => {
    expect(classifyBootstrapFailure(error)).toEqual(expected);
  });

  it("reads a request that got no answer on a device with no connection as offline", () => {
    expect(
      classifyBootstrapFailure(failure(null, "network_error"), false),
    ).toEqual({ kind: "offline" });
  });

  it.each<[string, unknown, boolean | undefined]>([
    ["no answer with the device online", failure(null, "network_error"), true],
    [
      "no answer with the device state left out",
      failure(null, "network_error"),
      undefined,
    ],
    ["a 502 on an offline device", failure(502, null), false],
    ["a 504 on an offline device", failure(504, null), false],
    ["a 503 relay on an offline device", failure(503, null), false],
    ["a TypeError on an offline device", new TypeError(SENTINEL), false],
  ])("keeps %s as asleep", (_name, error, deviceOnline) => {
    expect(classifyBootstrapFailure(error, deviceOnline)).toEqual({
      kind: "unreachable",
    });
  });

  it.each<[string, unknown, GuestLoadFailure]>([
    ["503 project_busy", failure(503, "project_busy"), { kind: "busy" }],
    ["404", failure(404, "share_not_found"), { kind: "bad-link" }],
    ["500", failure(500, null), { kind: "server" }],
    ["403", failure(403, "share_acl_denied"), { kind: "restricted" }],
    [
      "429",
      failure(429, "rate_limited", 12),
      { kind: "rate-limited", retryAfterSec: 12 },
    ],
    [
      "an abort",
      new DOMException("aborted", "AbortError"),
      { kind: "unreachable" },
    ],
    ["a non-JSON 200", new SyntaxError(SENTINEL), { kind: "intercepted" }],
  ])("reads %s the same on an offline device", (_name, error, expected) => {
    expect(classifyBootstrapFailure(error, false)).toEqual(expected);
  });
});

const NOT_LOADED = "This link did not load";

describe("guestLoadCover", () => {
  const rows: [
    GuestLoadFailure,
    string,
    string,
    string | null,
    number | null,
  ][] = [
    [
      { kind: "bad-link" },
      "This link doesn't open anything",
      "Ask the person who sent it for a new link.",
      null,
      null,
    ],
    [
      { kind: "unreachable" },
      "The host's computer is asleep",
      "This page tries again every 30 seconds.",
      "Try now",
      30_000,
    ],
    [
      { kind: "busy" },
      NOT_LOADED,
      "This episode is busy for a moment; this page tries again every 30 seconds.",
      "Retry",
      30_000,
    ],
    [
      { kind: "restricted" },
      NOT_LOADED,
      "This link is only for certain people; ask the person who sent it to check it was made for you.",
      null,
      null,
    ],
    [
      { kind: "sign-in" },
      NOT_LOADED,
      "This link needs a sign-in; ask the person who sent it how to sign in.",
      null,
      null,
    ],
    [
      { kind: "unavailable" },
      NOT_LOADED,
      "This link isn't available right now; ask the person who sent it to check it.",
      "Retry",
      null,
    ],
    [
      { kind: "intercepted" },
      NOT_LOADED,
      "This network did not pass the page through; on public Wi-Fi, sign in to the Wi-Fi first, then try again.",
      "Retry",
      null,
    ],
    [
      { kind: "server" },
      NOT_LOADED,
      "Try again, and if it keeps happening, tell the person who sent it.",
      "Retry",
      null,
    ],
    [
      { kind: "no-review-routes" },
      NOT_LOADED,
      "This address cannot open review links; ask the person who sent it to check the link.",
      null,
      null,
    ],
  ];

  it.each(rows)(
    "%j says its title, sentence, button and retry delay",
    (kind, title, sentence, button, autoRetryMs) => {
      expect(guestLoadCover(kind)).toMatchObject({
        title,
        sentence,
        button,
        autoRetryMs,
      });
    },
  );

  it("retries a rate limit at the clamped Retry-After", () => {
    const at = (retryAfterSec: number | null) =>
      guestLoadCover({ kind: "rate-limited", retryAfterSec });
    expect(at(null).autoRetryMs).toBe(30_000);
    expect(at(0).autoRetryMs).toBe(5_000);
    expect(at(20).autoRetryMs).toBe(20_000);
    expect(at(9_999).autoRetryMs).toBe(120_000);
    expect(at(20)).toMatchObject({
      title: NOT_LOADED,
      button: "Retry",
    });
  });

  it.each([
    [null, "in a moment"],
    [1, "in a moment"],
    [30, "in a moment"],
    [31, "in about a minute"],
    [90, "in about a minute"],
    [91, "in about two minutes"],
    [9_999, "in about two minutes"],
  ])("names a rate limit's wait for Retry-After %s as %s", (sec, words) => {
    expect(
      guestLoadCover({ kind: "rate-limited", retryAfterSec: sec }).sentence,
    ).toBe(`This link is busy right now; this page tries again ${words}.`);
  });

  it("tells a guest whose own device has no connection so, with the page opening by itself", () => {
    expect(guestLoadCover({ kind: "offline" })).toEqual({
      glyph: "cloud-off",
      title: "You're offline",
      sentence:
        "This page opens the episode by itself when your connection is back.",
      button: "Try now",
      autoRetryMs: 30_000,
      stillFailing: "Still offline.",
    });
  });

  it("says Still asleep. only for the asleep cover and Still offline. only for the offline one", () => {
    expect(guestLoadCover({ kind: "unreachable" }).stillFailing).toBe(
      "Still asleep.",
    );
    expect(guestLoadCover({ kind: "offline" }).stillFailing).toBe(
      "Still offline.",
    );
    for (const [kind] of rows.filter(
      ([k]) => k.kind !== "unreachable" && k.kind !== "offline",
    )) {
      expect(guestLoadCover(kind).stillFailing).toBe("Still not loading.");
    }
  });
});

describe("noAnswerStatus", () => {
  it.each<[number | null, string | null, boolean]>([
    [null, null, true],
    [null, "network_error", true],
    [502, null, true],
    [504, null, true],
    [503, null, true],
    [503, "project_busy", false],
    [500, null, false],
    [404, null, false],
    [429, null, false],
  ])("status %s, code %s: no answer is %s", (status, code, expected) => {
    expect(noAnswerStatus(status, code)).toBe(expected);
  });
});

describe("guestLoadCover inside a region of the studio", () => {
  const title = "The transcript didn't load";

  it("puts the region's title and button on the causes that have none of their own", () => {
    for (const kind of [
      "busy",
      "unavailable",
      "intercepted",
      "server",
    ] as const) {
      const cover = guestLoadCover({ kind }, title, "Try again");
      expect(cover.title).toBe(title);
      expect(cover.button).toBe("Try again");
      expect(cover.sentence).toBe(guestLoadCover({ kind }).sentence);
    }
    expect(
      guestLoadCover(
        { kind: "rate-limited", retryAfterSec: null },
        title,
        "Try again",
      ),
    ).toMatchObject({ title, button: "Try again" });
  });

  it("keeps its own title and button for asleep and offline, and no button for a sign-in", () => {
    expect(
      guestLoadCover({ kind: "unreachable" }, title, "Try again"),
    ).toMatchObject({
      title: "The host's computer is asleep",
      button: "Try now",
    });
    expect(
      guestLoadCover({ kind: "offline" }, title, "Try again"),
    ).toMatchObject({
      title: "You're offline",
      button: "Try now",
    });
    expect(
      guestLoadCover({ kind: "sign-in" }, title, "Try again").button,
    ).toBeNull();
    expect(
      guestLoadCover({ kind: "restricted" }, title, "Try again").button,
    ).toBeNull();
  });
});
