import { describe, expect, it } from "vitest";
import { UnusableAnswerError } from "./api/project";
import { guestLoadCover } from "./guestLoadFailure";
import {
  autoRetryMsOf,
  classifyShellFailure,
  type HostLoadKind,
  type ShellFailure,
  shellFailureCover,
} from "./shellLoadFailure";
import { ApiError, LINK_DOUBT_MESSAGE } from "./utils/apiError";

const MARKER = "ZEBRA-secret-9931 db password=hunter2";
const STAGE = "The transcript didn't load";

function api(
  status: number | null,
  code: string | null = null,
  retryAfterSec: number | null = null,
) {
  return new ApiError(
    MARKER,
    code,
    status,
    null,
    { detail: MARKER },
    retryAfterSec,
  );
}

const guest = (error: unknown, online = true) =>
  classifyShellFailure(error, "guest", online);
const host = (error: unknown) => classifyShellFailure(error, "host", true);

const guestKind = (error: unknown, online = true) => {
  const failure = guest(error, online);
  if (failure.audience !== "guest") throw new Error("not a guest failure");
  return failure.failure.kind;
};
const hostKind = (error: unknown): HostLoadKind => {
  const failure = host(error);
  if (failure.audience !== "host") throw new Error("not a host failure");
  return failure.kind;
};

const timeout = () =>
  new DOMException("The server didn't answer.", "TimeoutError");

describe("the guest's classification of the studio's first read", () => {
  it.each([
    [
      "no answer, device online",
      api(null, "network_error"),
      true,
      "unreachable",
    ],
    ["no answer, device offline", api(null, "network_error"), false, "offline"],
    ["502", api(502), true, "unreachable"],
    ["504", api(504), true, "unreachable"],
    ["a relay's 503", api(503), true, "unreachable"],
    ["503 project_busy", api(503, "project_busy"), true, "busy"],
    ["429", api(429, "rate_limited", 60), true, "rate-limited"],
    ["401", api(401), true, "sign-in"],
    ["403", api(403), true, "restricted"],
    ["500", api(500), true, "server"],
    ["500 internal_error", api(500, "internal_error"), true, "server"],
    ["400 with another code", api(400, "invalid_request"), true, "server"],
    ["a status no table knows", api(418), true, "server"],
    [
      "404 project_not_found",
      api(404, "project_not_found"),
      true,
      "unavailable",
    ],
    [
      "400 project_unreadable",
      api(400, "project_unreadable"),
      true,
      "unavailable",
    ],
    [
      "400 project_version_newer",
      api(400, "project_version_newer"),
      true,
      "unavailable",
    ],
    [
      "400 project_version_unsupported",
      api(400, "project_version_unsupported"),
      true,
      "unavailable",
    ],
    [
      "500 project_unreadable",
      api(500, "project_unreadable"),
      true,
      "unavailable",
    ],
    ["a coded 404 share_not_found", api(404, "share_not_found"), true, "doubt"],
    ["a 404 with no code", api(404), true, "server"],
    [
      "a page that was not JSON",
      new SyntaxError("Unexpected token <"),
      true,
      "intercepted",
    ],
    ["a read that never answered", timeout(), true, "unreachable"],
    [
      "an answer of the wrong shape",
      new UnusableAnswerError("Invalid document state"),
      true,
      "server",
    ],
    [
      "a plain throw from the applier",
      new TypeError("x is undefined"),
      true,
      "server",
    ],
    ["undefined", undefined, true, "server"],
    ["a string", "boom", true, "server"],
    ["an object", {}, true, "server"],
  ])("%s reads %s", (_name, error, online, kind) => {
    expect(guestKind(error, online)).toBe(kind);
  });

  it("carries the wait a 429 asked for, and only that", () => {
    expect(guest(api(429, "rate_limited", 60))).toEqual({
      audience: "guest",
      failure: { kind: "rate-limited", retryAfterSec: 60 },
    });
    expect(guest(api(429, "rate_limited"))).toEqual({
      audience: "guest",
      failure: { kind: "rate-limited", retryAfterSec: null },
    });
  });

  it("is never the dead-link ending's kind, which has no button", () => {
    for (const error of [api(404), api(404, "share_not_found")]) {
      expect(guestKind(error)).not.toBe("bad-link");
    }
  });

  it("is decided by status and code, never by what the message says", () => {
    expect(guestKind(new ApiError("host offline", null, 500))).toBe("server");
    expect(guestKind(new ApiError("share not found", null, 500))).toBe(
      "server",
    );
    expect(
      guestKind(new ApiError("The server didn't answer.", null, 500)),
    ).toBe("server");
  });
});

describe("the host's classification of the studio's first read", () => {
  it.each([
    ["500 project_unreadable", api(500, "project_unreadable"), "damaged"],
    ["a 400 project_unreadable", api(400, "project_unreadable"), "damaged"],
    ["404 project_not_found", api(404, "project_not_found"), "missing"],
    [
      "a 500 project_not_found: the code wins",
      api(500, "project_not_found"),
      "missing",
    ],
    ["400 project_path_invalid", api(400, "project_path_invalid"), "other"],
    ["503 project_busy", api(503, "project_busy"), "busy"],
    [
      "403 project_path_not_allowed",
      api(403, "project_path_not_allowed"),
      "elsewhere",
    ],
    ["no answer", api(null, "network_error"), "not-answering"],
    ["502", api(502), "not-answering"],
    ["504", api(504), "not-answering"],
    ["a 503 with no code", api(503), "not-answering"],
    ["a read that never answered", timeout(), "not-answering"],
    ["a plain 500", api(500), "other"],
    [
      "a 500 whose text says the server did not answer",
      new ApiError("The server didn't answer.", null, 500),
      "other",
    ],
    ["403 authz_denied", api(403, "authz_denied"), "other"],
    ["400 with no code", api(400), "other"],
    ["422", api(422, "invalid_request"), "other"],
    ["401", api(401), "other"],
    ["429", api(429, "rate_limited", 30), "other"],
    [
      "share_not_found on the host's route",
      api(404, "share_not_found"),
      "other",
    ],
    ["a 404 with no code", api(404), "other"],
    [
      "a page that was not JSON",
      new SyntaxError("Unexpected token <"),
      "other",
    ],
    [
      "an answer of the wrong shape",
      new UnusableAnswerError("Invalid document basis"),
      "other",
    ],
    ["a plain Error", new Error("temporary failure"), "other"],
    ["undefined", undefined, "other"],
    ["a string", "boom", "other"],
  ] as const)("%s reads %s", (_name, error, kind) => {
    expect(hostKind(error)).toBe(kind);
  });
});

describe("the words", () => {
  const cover = (failure: ShellFailure, name = "Rosa and Maya") =>
    shellFailureCover(failure, { stageTitle: STAGE, name });
  const hostCover = (kind: HostLoadKind, name?: string) =>
    cover({ audience: "host", kind }, name);

  it.each([
    [
      "missing",
      `ShareCut can't find "Rosa and Maya". Its folder may have been moved, renamed or deleted.`,
      { retry: "Try again", home: true, lead: "home" },
      "Still can't find it.",
      "Can't find the episode.",
    ],
    [
      "damaged",
      `ShareCut can't read "Rosa and Maya" because its file is damaged. Restore the file from a backup, or open a copy of the episode.`,
      { retry: "Try again", home: true, lead: "home" },
      "Still can't read it.",
      "The file is damaged.",
    ],
    [
      "busy",
      "Something else is using this episode for a moment.",
      { retry: "Try again", home: false, lead: "retry" },
      "Still busy.",
      "The episode is busy.",
    ],
    [
      "not-answering",
      "ShareCut isn't answering. Check that it is still running on this computer.",
      { retry: "Try again", home: false, lead: "retry" },
      "Still not answering.",
      "ShareCut isn't answering.",
    ],
    [
      "other",
      `ShareCut couldn't open "Rosa and Maya". If a newer version of ShareCut saved it, update ShareCut first.`,
      { retry: "Try again", home: true, lead: "retry" },
      "Still not loading.",
      "It didn't open.",
    ],
  ] as const)(
    "a host's %s says its one sentence under the stage's title",
    (kind, sentence, buttons, still, changed) => {
      expect(hostCover(kind)).toMatchObject({
        key: kind,
        glyph: "triangle-alert",
        title: STAGE,
        sentence,
        ...buttons,
        stillFailing: still,
        changed,
      });
    },
  );

  it("tells a host whose computer is open on another episode to go to all projects, with nothing to retry", () => {
    expect(hostCover("elsewhere")).toMatchObject({
      key: "elsewhere",
      glyph: "folder-open",
      title: "This episode isn't open on this computer",
      sentence: "This computer is open on a different episode.",
      retry: null,
      home: true,
    });
  });

  it("names the episode only by its name, and says this episode when it has none", () => {
    expect(hostCover("missing", "").sentence).toBe(
      "ShareCut can't find this episode. Its folder may have been moved, renamed or deleted.",
    );
    expect(hostCover("damaged", "").sentence).toBe(
      "ShareCut can't read this episode because its file is damaged. Restore the file from a backup, or open a copy of the episode.",
    );
    expect(hostCover("other", "").sentence).toBe(
      "ShareCut couldn't open this episode. If a newer version of ShareCut saved it, update ShareCut first.",
    );
  });

  it("never ends a sentence in its button's own words or uses a phrase the terminology table bans", () => {
    const banned = [
      /not found/i,
      /internal error/i,
      /server error/i,
      /\bhost offline\b/i,
      /tunnel/i,
      /relay/i,
    ];
    const kinds: HostLoadKind[] = [
      "missing",
      "damaged",
      "busy",
      "elsewhere",
      "not-answering",
      "other",
    ];
    for (const kind of kinds) {
      const { sentence } = hostCover(kind);
      for (const phrase of banned) expect(sentence).not.toMatch(phrase);
      expect(sentence).not.toMatch(/try again\.?$/i);
    }
  });

  const GUEST_ROWS = [
    [
      { kind: "unreachable" },
      "The host's computer is asleep",
      "Try now",
      30_000,
    ],
    [{ kind: "offline" }, "You're offline", "Try now", 30_000],
    [{ kind: "busy" }, STAGE, "Try again", 30_000],
    [{ kind: "rate-limited", retryAfterSec: null }, STAGE, "Try again", 30_000],
    [{ kind: "rate-limited", retryAfterSec: 60 }, STAGE, "Try again", 60_000],
    [{ kind: "rate-limited", retryAfterSec: 1 }, STAGE, "Try again", 5_000],
    [{ kind: "sign-in" }, STAGE, null, null],
    [{ kind: "restricted" }, STAGE, null, null],
    [{ kind: "unavailable" }, STAGE, "Try again", null],
    [{ kind: "intercepted" }, STAGE, "Try again", null],
    [{ kind: "server" }, STAGE, "Try again", null],
  ] as const;

  it.each(GUEST_ROWS)(
    "a guest's %j reads what the page cover reads for the same cause",
    (failure, title, button, auto) => {
      const shell = cover({ audience: "guest", failure });
      const page = guestLoadCover(failure);
      expect(shell.title).toBe(title);
      expect(shell.sentence).toBe(page.sentence);
      expect(shell.glyph).toBe(page.glyph);
      expect(shell.retry).toBe(button);
      expect(shell.home).toBe(false);
      expect(autoRetryMsOf({ audience: "guest", failure })).toBe(auto);
      expect(shell.stillFailing).toBe(page.stillFailing);
      expect(shell.key).toBe(title);
      expect(shell.changed).toBe(`${title}.`);
    },
  );

  it("says the link-doubt sentence, with a button and no retry by itself, when a link may be gone", () => {
    expect(
      cover({ audience: "guest", failure: { kind: "doubt" } }),
    ).toMatchObject({
      glyph: "triangle-alert",
      title: STAGE,
      sentence: LINK_DOUBT_MESSAGE,
      retry: "Try again",
      home: false,
      stillFailing: "Still not loading.",
    });
  });

  it("retries by itself for a guest's asleep, offline, busy and rate-limited, and for nobody else", () => {
    const guestKinds = [
      { kind: "unreachable" },
      { kind: "offline" },
      { kind: "busy" },
      { kind: "rate-limited", retryAfterSec: 90 },
      { kind: "sign-in" },
      { kind: "restricted" },
      { kind: "unavailable" },
      { kind: "intercepted" },
      { kind: "server" },
      { kind: "doubt" },
    ] as const;
    expect(
      guestKinds.map((failure) =>
        autoRetryMsOf({ audience: "guest", failure }),
      ),
    ).toEqual([
      30_000,
      30_000,
      30_000,
      90_000,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    for (const kind of [
      "missing",
      "damaged",
      "busy",
      "elsewhere",
      "not-answering",
      "other",
    ] as const) {
      expect(autoRetryMsOf({ audience: "host", kind })).toBeNull();
    }
  });
});

describe("what the server said never reaches a sentence", () => {
  const statuses = [
    null,
    400,
    401,
    403,
    404,
    409,
    418,
    422,
    429,
    500,
    502,
    503,
    504,
  ];
  const codes = [
    null,
    "network_error",
    "share_not_found",
    "project_busy",
    "project_unreadable",
    "project_not_found",
    "project_path_invalid",
    "project_path_not_allowed",
    "project_version_newer",
    "authz_denied",
    "rate_limited",
    "internal_error",
  ];
  const shapes: unknown[] = [
    new SyntaxError(MARKER),
    new UnusableAnswerError(MARKER),
    new Error(MARKER),
    new TypeError(MARKER),
    new DOMException(MARKER, "TimeoutError"),
    MARKER,
    { detail: MARKER },
    undefined,
  ];

  const everyError = () => [
    ...statuses.flatMap((status) =>
      codes.map((code) => api(status, code, status === 429 ? 45 : null)),
    ),
    ...shapes,
  ];

  it.each(["guest", "host"] as const)(
    "holds no marker in a %s's classification or cover",
    (audience) => {
      for (const error of everyError()) {
        for (const online of [true, false]) {
          const failure = classifyShellFailure(error, audience, online);
          const text = JSON.stringify([
            failure,
            shellFailureCover(failure, {
              stageTitle: STAGE,
              name: "Rosa and Maya",
            }),
          ]);
          expect(text).not.toContain("ZEBRA");
          expect(text).not.toContain("hunter2");
        }
      }
    },
  );

  it("falls to the general sentence for a shape nothing knows", () => {
    for (const error of [undefined, "boom", {}, 42]) {
      expect(guestKind(error)).toBe("server");
      expect(hostKind(error)).toBe("other");
    }
  });
});
