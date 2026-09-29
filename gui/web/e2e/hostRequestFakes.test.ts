import { describe, expect, it } from "vitest";
import { hostWithResponse } from "./hostRequestFakes";

describe("hostWithResponse", () => {
  it("resolves post with an ok 200 response carrying the JSON body", async () => {
    const { page, post } = hostWithResponse(true, { a: 1 });
    const res = await page.request.post();
    expect(res.ok()).toBe(true);
    expect(res.status()).toBe(200);
    await expect(res.json()).resolves.toEqual({ a: 1 });
    await expect(res.text()).resolves.toBe('{"a":1}');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("defaults a failed response to 400 and honours an explicit status", async () => {
    expect(
      (await hostWithResponse(false, {}).page.request.post()).status(),
    ).toBe(400);
    expect(
      (await hostWithResponse(false, {}, 409).page.request.post()).status(),
    ).toBe(409);
  });
});
