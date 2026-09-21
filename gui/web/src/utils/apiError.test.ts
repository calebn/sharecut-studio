import { describe, expect, it } from "vitest";
import { readApiFailure, TRANSCRIPT_REFINE_REQUIRED_CODE } from "./apiError";

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
