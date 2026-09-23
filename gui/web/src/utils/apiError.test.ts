import { describe, expect, it } from "vitest";
import {
  ApiError,
  errorMessage,
  isClientRejection,
  readApiFailure,
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
    expect(isClientRejection(error)).toBe(true);
    expect(isClientRejection(new ApiError("busy", null, 503))).toBe(false);
    expect(isClientRejection(new Error("offline"))).toBe(false);
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
