import { describe, expect, it } from "vitest";
import {
  errorMessage,
  readApiFailure,
  TRANSCRIPT_REFINE_REQUIRED_CODE,
} from "./apiError";

describe("errorMessage", () => {
  it("uses an Error's message and stringifies anything else", () => {
    expect(errorMessage(new Error("disk full"))).toBe("disk full");
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
});
