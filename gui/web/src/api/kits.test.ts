import { beforeEach, describe, expect, it, vi } from "vitest";
import { documentClientId } from "../utils/documentClient";
import { apiFetch, HOST_KEY } from "./http";
import { applyKit, type KitOffer, loadKitOffer } from "./kits";

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

  it("posts the apply with the path, kit, offered version and this tab's client id", async () => {
    const report = {
      kit_id: "show-1",
      kit_version: 3,
      undo_steps: 2,
      history_head_id: "h2",
    };
    vi.mocked(apiFetch).mockResolvedValue(json(report));
    expect(
      await applyKit("/p/ep.sharecut", { id: "show-1", version: 3 }),
    ).toEqual(report);
    const [key, route, init] = vi.mocked(apiFetch).mock.calls[0];
    expect(key).toBe(HOST_KEY);
    expect(route).toEqual({ host: "/api/kits/apply" });
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      path: "/p/ep.sharecut",
      kit_id: "show-1",
      kit_version: 3,
      client_id: documentClientId(),
    });
  });

  it("lets a refusal reach the caller", async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error("kit_changed"));
    await expect(
      applyKit("/p/ep.sharecut", { id: "show-1", version: 3 }),
    ).rejects.toThrow("kit_changed");
  });
});
