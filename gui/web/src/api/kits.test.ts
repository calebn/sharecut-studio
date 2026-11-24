import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, HOST_KEY } from "./http";
import { type KitOffer, loadKitOffer } from "./kits";

vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  apiFetch: vi.fn(),
}));

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe("kit routes", () => {
  it("loads the offer for one project, escaping its path", async () => {
    const offer: KitOffer = {
      offer: false,
      reason: "no_clips",
      kits: [],
      unusable: [],
    };
    vi.mocked(apiFetch).mockResolvedValue(json(offer));
    expect(await loadKitOffer("/p/my ep&x.sharecut")).toEqual(offer);
    const call = vi.mocked(apiFetch).mock.calls[0];
    expect(call[0]).toBe(HOST_KEY);
    expect(call[1]).toEqual({
      host: "/api/kits/offer?path=%2Fp%2Fmy%20ep%26x.sharecut",
    });
  });
});
