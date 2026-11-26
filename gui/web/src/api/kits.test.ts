import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../utils/apiError";
import { documentClientId } from "../utils/documentClient";
import { apiFetch, HOST_KEY } from "./http";
import {
  applyKit,
  cancelKitImport,
  commitKitImport,
  downloadKitFile,
  isDamagedKit,
  KIT_TOO_LARGE_MESSAGE,
  type KitListRow,
  type KitOffer,
  kitSaveRefusal,
  loadKitOffer,
  loadKits,
  partialImport,
  previewKitImport,
  saveKit,
} from "./kits";

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

describe("kit library routes", () => {
  it("lists the kits, healthy and damaged rows together", async () => {
    const rows: KitListRow[] = [
      {
        id: "show-kit-1",
        name: "Show Kit",
        version: 1,
        versions: [1],
        entries: 2,
        missing: 0,
        usable: true,
        problem: null,
      },
      {
        id: "bad-2",
        damaged: true,
        version: 1,
        usable: false,
        problem: "unreadable",
        code: "kit_invalid",
      },
    ];
    vi.mocked(apiFetch).mockResolvedValue(json(rows));
    const list = await loadKits();
    expect(list).toEqual(rows);
    expect(list.map(isDamagedKit)).toEqual([false, true]);
    const call = vi.mocked(apiFetch).mock.calls[0];
    expect(call[0]).toBe(HOST_KEY);
    expect(call[1]).toEqual({ host: "/api/kits" });
  });

  it("downloads the file whole and names it from the server's file name", async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      new Response("zip", {
        headers: {
          "content-disposition": 'attachment; filename="show-kit.sharecutkit"',
        },
      }),
    );
    const { blob, filename } = await downloadKitFile("show-kit-1a2b");
    expect(filename).toBe("show-kit.sharecutkit");
    expect(await blob.text()).toBe("zip");
    expect(vi.mocked(apiFetch).mock.calls[0][1]).toEqual({
      host: "/api/kits/show-kit-1a2b/export",
    });
  });

  it("falls back to the id when the server names no usable file", async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      new Response("zip", {
        headers: { "content-disposition": 'attachment; filename="a b.zip"' },
      }),
    );
    expect((await downloadKitFile("a-1")).filename).toBe("a-1.sharecutkit");
  });
});

describe("kit import routes", () => {
  const file = new File(["zip"], "show.sharecutkit");

  it("sends the file as the raw body, not a form", async () => {
    vi.mocked(apiFetch).mockResolvedValue(json({ token: "t" }));
    const controller = new AbortController();
    await previewKitImport(file, controller.signal);
    const [key, route, init] = vi.mocked(apiFetch).mock.calls[0];
    expect(key).toBe(HOST_KEY);
    expect(route).toEqual({ host: "/api/kits/import/preview" });
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(file);
    expect(init?.headers).toEqual({
      "Content-Type": "application/octet-stream",
    });
    expect(init?.signal).toBe(controller.signal);
  });

  it("commits with the token and nothing else", async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      json({ kit: { status: "added", id: "k", version: 1 }, segments: [] }),
    );
    await commitKitImport("tok");
    const [, route, init] = vi.mocked(apiFetch).mock.calls[0];
    expect(route).toEqual({ host: "/api/kits/import" });
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ token: "tok" });
  });

  it("says so in plain words when a 2xx is not JSON, never the parser's text", async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      new Response("<html>Sign in to the network</html>", { status: 200 }),
    );
    const failure = await previewKitImport(file).catch((error) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.message).not.toMatch(/JSON|Unexpected|token/i);
    expect(failure.message).toMatch(/can't read/);
    await expect(commitKitImport("t")).rejects.toMatchObject({
      code: "bad_reply",
    });
  });

  it("cancels with a keepalive DELETE on the escaped token", async () => {
    vi.mocked(apiFetch).mockResolvedValue(json({ cancelled: "a/b" }));
    await cancelKitImport("a/b");
    const [, route, init] = vi.mocked(apiFetch).mock.calls[0];
    expect(route).toEqual({ host: "/api/kits/import/a%2Fb" });
    expect(init).toEqual({ method: "DELETE", keepalive: true });
  });

  it.each([
    ["a proxy's coded refusal", new ApiError("x", "payload_too_large", 413)],
    ["a proxy's bare 413", new ApiError("x", null, 413)],
  ])("says the file is too large for %s", async (_name, failure) => {
    vi.mocked(apiFetch).mockRejectedValue(failure);
    await expect(previewKitImport(file)).rejects.toMatchObject({
      message: KIT_TOO_LARGE_MESSAGE,
    });
  });

  it("says payload_too_large is too large even without a 413 status", async () => {
    vi.mocked(apiFetch).mockRejectedValue(
      new ApiError("x", "payload_too_large", 502),
    );
    await expect(previewKitImport(file)).rejects.toMatchObject({
      message: KIT_TOO_LARGE_MESSAGE,
      code: "payload_too_large",
    });
  });

  it("names the chosen file, not the staging file, in a refusal", async () => {
    const refusal = new ApiError(
      "a376bd21ce14b4264713e8abebb91f63.partial is not a kit bundle.",
      "kit_bundle_invalid",
      422,
      null,
      { detail: "x" },
    );
    vi.mocked(apiFetch).mockRejectedValue(refusal);
    const failure = await previewKitImport(
      new File(["x"], "not-a-kit.sharecutkit"),
    ).catch((error) => error);
    expect(failure.message).toBe("not-a-kit.sharecutkit is not a kit bundle.");
    expect(failure).toMatchObject({
      code: "kit_bundle_invalid",
      status: 422,
      body: { detail: "x" },
    });
  });

  it("says the connection dropped, not that the file is too large", async () => {
    const dropped = new ApiError(
      "Couldn't reach the server. Check your connection and try again.",
      "network_error",
    );
    vi.mocked(apiFetch).mockRejectedValue(dropped);
    await expect(previewKitImport(file)).rejects.toBe(dropped);
  });

  it("keeps the server's own words for its size limit and other refusals", async () => {
    const limit = new ApiError(
      "Kit files are limited to 1 GiB.",
      "kit_upload_too_large",
      413,
    );
    vi.mocked(apiFetch).mockRejectedValueOnce(limit);
    await expect(previewKitImport(file)).rejects.toBe(limit);
    const invalid = new ApiError("Not a kit.", "kit_bundle_invalid", 422);
    vi.mocked(apiFetch).mockRejectedValueOnce(invalid);
    await expect(previewKitImport(file)).rejects.toBe(invalid);
  });

  it("reads how many segments landed from a refused commit's body", () => {
    const body = {
      detail: "Busy.",
      segments_added: [{ status: "added", id: "a", version: 1 }],
      segments_total: 3,
    };
    expect(
      partialImport(new ApiError("Busy.", "kit_busy", 409, null, body)),
    ).toEqual({
      added: 1,
      total: 3,
    });
    expect(partialImport(new ApiError("Busy.", "kit_busy", 409))).toBeNull();
    expect(
      partialImport(
        new ApiError("x", "kit_busy", 409, null, { segments_added: "no" }),
      ),
    ).toBeNull();
    expect(partialImport(new Error("x"))).toBeNull();
    const malformed = [
      { segments_added: [], segments_total: "3" },
      { segments_added: null, segments_total: 3 },
      { segments_added: { length: 2 }, segments_total: 3 },
      { segments_added: [] },
    ];
    for (const body of malformed)
      expect(
        partialImport(new ApiError("x", "kit_busy", 409, null, body)),
      ).toBeNull();
    expect(
      partialImport(new ApiError("x", "kit_busy", 409, null, "text")),
    ).toBeNull();
    expect(
      partialImport(new ApiError("x", "kit_busy", 409, null, null)),
    ).toBeNull();
  });
});

describe("kit save route", () => {
  it("posts the name and the entries, and nothing else", async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      json({ status: "added", id: "show-kit-1a2b", version: 1 }),
    );
    const request = {
      name: "Show Kit",
      entries: [
        { segment_id: "intro-9f3a", at: "start" as const },
        { segment_id: "outro-77de", at: "end" as const },
      ],
    };
    expect(await saveKit(request)).toEqual({
      status: "added",
      id: "show-kit-1a2b",
      version: 1,
    });
    const [key, route, init] = vi.mocked(apiFetch).mock.calls[0];
    expect(key).toBe(HOST_KEY);
    expect(route).toEqual({ host: "/api/kits" });
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual(request);
  });

  it("names the refusal codes the sheet knows and no others", () => {
    const refused = (code: string | null) =>
      kitSaveRefusal(new ApiError("no", code, 409));
    expect(refused("kit_segment_missing")).toBe("kit_segment_missing");
    expect(refused("kit_busy")).toBe("kit_busy");
    expect(refused("project_write_failed")).toBeNull();
    expect(refused(null)).toBeNull();
    expect(kitSaveRefusal(new Error("kit_busy"))).toBeNull();
  });
});
