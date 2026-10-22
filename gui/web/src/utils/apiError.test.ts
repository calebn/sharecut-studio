import { describe, expect, it } from "vitest";
import {
  ApiError,
  errorMessage,
  isAbortError,
  isPermanentRejection,
  isServerTimeoutError,
  readApiFailure,
  refusalReason,
  TRANSCRIPT_REFINE_REQUIRED_CODE,
} from "./apiError";

describe("errorMessage", () => {
  it("uses an Error's message even when a fallback is supplied", () => {
    expect(errorMessage(new Error("disk full"))).toBe("disk full");
    expect(errorMessage(new Error("disk full"), "save failed")).toBe(
      "disk full",
    );
  });

  it("uses a caller fallback for non-Errors and keeps one-argument stringification", () => {
    expect(errorMessage("plain", "save failed")).toBe("save failed");
    expect(errorMessage(null, "save failed")).toBe("save failed");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("readApiFailure", () => {
  it("retains the stable code and human-readable message", async () => {
    const response = new Response(
      JSON.stringify({ detail: "Transcript refine is required before edits." }),
      {
        status: 409,
        headers: {
          "Content-Type": "application/json",
          "X-Sharecut-Error-Code": TRANSCRIPT_REFINE_REQUIRED_CODE,
        },
      },
    );

    const error = await readApiFailure(response);
    expect(error.message).toBe("Transcript refine is required before edits.");
    expect(error.code).toBe(TRANSCRIPT_REFINE_REQUIRED_CODE);
  });

  it("unwraps nested FastAPI conflict details", async () => {
    const response = new Response(
      JSON.stringify({
        detail: {
          detail: "Envelope changed; refresh and retry.",
          conflict: true,
        },
      }),
      { status: 409 },
    );
    const error = await readApiFailure(response);
    expect(error.message).toBe("Envelope changed; refresh and retry.");
  });

  it("keeps the HTTP status for callers that branch on it", async () => {
    const error = await readApiFailure(new Response("stale", { status: 409 }));
    expect(error.status).toBe(409);
    expect(isPermanentRejection(error)).toBe(true);
  });

  it("maps a bare JSON string host-offline body to the actionable copy", async () => {
    const error = await readApiFailure(
      new Response(JSON.stringify("Host offline"), { status: 502 }),
    );
    expect(error.message).toBe(
      "Host offline. Ask them to run podcast tunnel and try again.",
    );
  });

  it("maps a nested host-offline detail to the actionable copy", async () => {
    const error = await readApiFailure(
      new Response(JSON.stringify({ detail: { detail: "Host offline" } }), {
        status: 502,
      }),
    );
    expect(error.message).toMatch(/run podcast tunnel/);
  });

  it("stops unwrapping past the supported nesting depth", async () => {
    const deep = { detail: { detail: { detail: { detail: "too deep" } } } };
    const text = JSON.stringify(deep);
    const error = await readApiFailure(new Response(text, { status: 400 }));
    expect(error.message).toBe(text);
  });
});

describe("isPermanentRejection", () => {
  it("is true only for a 4xx other than 408 / 429", () => {
    for (const status of [400, 403, 404, 409, 422]) {
      expect(isPermanentRejection(new ApiError("x", null, status))).toBe(true);
    }
    for (const status of [408, 429, 500, 503]) {
      expect(isPermanentRejection(new ApiError("x", null, status))).toBe(false);
    }
    expect(isPermanentRejection(new ApiError("x", null, null))).toBe(false);
    expect(isPermanentRejection(new Error("offline"))).toBe(false);
  });
});

describe("isServerTimeoutError", () => {
  it("recognizes document load timeouts", () => {
    expect(
      isServerTimeoutError(
        new DOMException("The server didn't answer.", "TimeoutError"),
      ),
    ).toBe(true);
    expect(isServerTimeoutError(new Error("The server didn't answer."))).toBe(
      true,
    );
    expect(isServerTimeoutError(new Error("network down"))).toBe(false);
  });
});

describe("isAbortError", () => {
  it("accepts a DOMException or Error named AbortError", () => {
    expect(isAbortError(new DOMException("Aborted", "AbortError"))).toBe(true);
    const err = new Error("stop");
    err.name = "AbortError";
    expect(isAbortError(err)).toBe(true);
  });

  it("rejects other errors and non-errors", () => {
    expect(isAbortError(new DOMException("x", "NotFoundError"))).toBe(false);
    expect(isAbortError(new Error("boom"))).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});

describe("refusalReason", () => {
  it("is what errorMessage gives for the gate's refusal, so toasts carry no commands", () => {
    const gate = new ApiError(
      "Run `podcast transcript refine-waive --reason ...`",
      TRANSCRIPT_REFINE_REQUIRED_CODE,
      409,
    );
    expect(errorMessage(gate)).toBe(refusalReason(gate));
    expect(errorMessage(gate)).not.toMatch(/podcast/);
  });

  it("keeps a refusal's own message", () => {
    expect(
      refusalReason(new ApiError("Clip is gone", "document_conflict", 409)),
    ).toBe("Clip is gone");
  });

  it("replaces the transcript-refine gate's command-line advice with the app's one action", () => {
    const reason = refusalReason(
      new ApiError(
        "Run `podcast transcript refine-waive --reason ...`",
        TRANSCRIPT_REFINE_REQUIRED_CODE,
        409,
      ),
    );
    expect(reason).toMatch(/waive it with a reason/);
    expect(reason).not.toMatch(/podcast|--reason/);
  });
});
