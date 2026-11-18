import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../utils/apiError";
import { cachedFetchArrayBuffer } from "./chunkCache";
import type { ImmutableChunkRef } from "./proxyMath";

afterEach(() => vi.unstubAllGlobals());

for (const cacheAvailable of [false, true]) {
  describe(`chunk fetch with CacheStorage ${cacheAvailable}`, () => {
    it("preserves unavailable generation code and status", async () => {
      vi.stubGlobal(
        "caches",
        cacheAvailable
          ? { open: async () => ({ match: async () => undefined }) }
          : undefined,
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response("Generation unavailable", {
              status: 404,
              headers: {
                "X-Sharecut-Error-Code": "proxy_generation_unavailable",
              },
            }),
        ),
      );
      await expect(
        cachedFetchArrayBuffer("share:t", ref(0, "/chunk")),
      ).rejects.toMatchObject({
        name: "ApiError",
        code: "proxy_generation_unavailable",
        status: 404,
      });
    });

    it("preserves ordinary transport failure without inventing a code", async () => {
      vi.stubGlobal(
        "caches",
        cacheAvailable
          ? { open: async () => ({ match: async () => undefined }) }
          : undefined,
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("No chunk", { status: 404 })),
      );
      const error = await cachedFetchArrayBuffer(
        "share:t",
        ref(0, "/chunk"),
      ).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ code: null, status: 404 });
      expect(fetch).toHaveBeenCalledOnce();
    });
  });
}

const HASH = "a".repeat(64);
const LEGACY = "podcast-proxy-v1";

function ref(index: number, url: string, hash = HASH): ImmutableChunkRef {
  return { kind: "track", artifactId: "host", hash, index, url };
}

type Method = "open" | "match" | "put" | "delete" | "keys" | "has";
type Fault = "throw" | "reject" | (() => Promise<void>);

/**
 * An in-memory Cache Storage. A method can be made to throw before it
 * returns, to reject, or to wait on a promise the test holds, so a test can
 * place a forgetting at any step of a chunk's way into the cache.
 */
function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const faults: Partial<Record<Method, Fault>> = {};
  const calls: Record<Method, number> = {
    open: 0,
    match: 0,
    put: 0,
    delete: 0,
    keys: 0,
    has: 0,
  };
  const created: string[] = [];
  const step = <T>(method: Method, run: () => T): Promise<T> => {
    calls[method] += 1;
    const fault = faults[method];
    if (fault === "throw") throw new Error(`${method} threw`);
    if (fault === "reject")
      return Promise.reject(new Error(`${method} failed`));
    return Promise.resolve(fault?.()).then(run);
  };
  const urlOfKey = (key: RequestInfo | URL) =>
    typeof key === "string"
      ? key
      : key instanceof URL
        ? key.href
        : (key as Request).url;
  const cacheOf = (store: Map<string, Response>) => ({
    match: (key: RequestInfo | URL) =>
      step("match", () => store.get(urlOfKey(key))?.clone()),
    put: (key: RequestInfo | URL, res: Response) =>
      step("put", () => {
        store.set(urlOfKey(key), res);
      }),
    delete: (key: RequestInfo | URL) =>
      step("delete", () => store.delete(urlOfKey(key))),
    keys: () => step("keys", () => [...store.keys()].map((url) => ({ url }))),
  });
  const storage = {
    open: (name: string) =>
      step("open", () => {
        let store = stores.get(name);
        if (!store) {
          store = new Map();
          stores.set(name, store);
          created.push(name);
        }
        return cacheOf(store);
      }),
    has: (name: string) => step("has", () => stores.has(name)),
    delete: (name: string) => step("delete", () => stores.delete(name)),
    keys: async () => [...stores.keys()],
  };
  return {
    storage,
    faults,
    calls,
    created,
    names: () => [...stores.keys()],
    entries: (name: string) => [...(stores.get(name)?.keys() ?? [])],
    seed: (name: string) => {
      stores.set(name, stores.get(name) ?? new Map());
    },
  };
}

/** A promise a test settles by hand, to hold a step until it chooses. */
function gate() {
  let open: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { held: () => held, open };
}

let linkCount = 0;
/** `linkEnded` lives for the page and has no reset, so each test takes its own link. */
const freshLink = () => {
  linkCount += 1;
  return `unit-link-${linkCount}`;
};

/** A fetch that answers each URL with its own bytes, and can hold an answer. */
function stubFetch(hold?: Promise<void>) {
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    await hold;
    const url = String(input);
    return new Response(new Uint8Array([url.length, 7, 7]));
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** The module and the ended-links set under test, fresh for the test. */
async function load() {
  vi.resetModules();
  const cache = await import("./chunkCache");
  const ended = await import("../utils/linkEnded");
  return { ...cache, markLinkEnded: ended.markLinkEnded };
}

describe("the audio a link's guest keeps", () => {
  it("keeps a chunk under its identity in its own link's cache and serves the second call from it", async () => {
    const m = await load();
    const fake = fakeCaches();
    vi.stubGlobal("caches", fake.storage);
    const fetchSpy = stubFetch();
    const token = freshLink();
    const key = `share:${token}`;

    const first = await m.cachedFetchArrayBuffer(key, ref(0, "/chunk/0"));
    const second = await m.cachedFetchArrayBuffer(key, ref(0, "/chunk/0"));

    expect(second.byteLength).toBe(first.byteLength);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const own = fake.entries(`${m.LINK_AUDIO_PREFIX}${token}`);
    expect(own).toHaveLength(1);
    // The address is the chunk's identity; no URL the server issued is in it.
    expect(own[0]).not.toContain("/chunk/0");
    expect(fake.names()).toEqual([`${m.LINK_AUDIO_PREFIX}${token}`]);
  });

  it("serves the same chunk under a different URL from the cache (a presigned URL changes on every read)", async () => {
    const m = await load();
    vi.stubGlobal("caches", fakeCaches().storage);
    const fetchSpy = stubFetch();
    const key = `share:${freshLink()}`;

    await m.cachedFetchArrayBuffer(key, ref(3, "https://store/a?sig=1"));
    await m.cachedFetchArrayBuffer(key, ref(3, "https://store/a?sig=2"));
    expect(fetchSpy).toHaveBeenCalledOnce();

    await m.cachedFetchArrayBuffer(key, ref(4, "https://store/a?sig=2"));
    await m.cachedFetchArrayBuffer(
      key,
      ref(3, "https://store/a?sig=3", "b".repeat(64)),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("forgets one link and leaves another link's audio", async () => {
    const m = await load();
    const fake = fakeCaches();
    vi.stubGlobal("caches", fake.storage);
    const fetchSpy = stubFetch();
    const gone = freshLink();
    const kept = freshLink();
    await m.cachedFetchArrayBuffer(`share:${gone}`, ref(0, "/x/0"));
    await m.cachedFetchArrayBuffer(`share:${kept}`, ref(0, "/x/0"));
    await m.cachedFetchArrayBuffer(`share:${kept}`, ref(1, "/x/1"));

    await m.forgetLinkAudio(gone);

    expect(fake.names()).toEqual([`${m.LINK_AUDIO_PREFIX}${kept}`]);
    expect(fake.entries(`${m.LINK_AUDIO_PREFIX}${kept}`)).toHaveLength(2);
    fetchSpy.mockClear();
    await m.cachedFetchArrayBuffer(`share:${kept}`, ref(1, "/x/1"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not take a link whose name starts with another's for that other", async () => {
    const m = await load();
    const fake = fakeCaches();
    vi.stubGlobal("caches", fake.storage);
    stubFetch();
    await m.cachedFetchArrayBuffer("share:a-b-c", ref(0, "/x/0"));
    await m.cachedFetchArrayBuffer("share:a-b-c-d", ref(0, "/x/0"));
    await m.forgetLinkAudio("a-b-c");
    expect(fake.names()).toEqual([`${m.LINK_AUDIO_PREFIX}a-b-c-d`]);
  });

  describe("forgetLinkAudio", () => {
    it("deletes the link's cache and the old shared cache, creating nothing", async () => {
      const m = await load();
      const fake = fakeCaches();
      vi.stubGlobal("caches", fake.storage);
      stubFetch();
      const token = freshLink();
      await m.cachedFetchArrayBuffer(`share:${token}`, ref(0, "/x/0"));
      fake.seed(LEGACY);
      const opened = fake.calls.open;

      await m.forgetLinkAudio(token);

      expect(fake.names()).toEqual([]);
      expect(fake.calls.open).toBe(opened);
    });

    it("creates no cache for a link that has none", async () => {
      const m = await load();
      const fake = fakeCaches();
      vi.stubGlobal("caches", fake.storage);
      await m.forgetLinkAudio(freshLink());
      expect(fake.created).toEqual([]);
    });

    it.each<Fault>(["throw", "reject"])(
      "resolves when delete %s",
      async (fault) => {
        const m = await load();
        const fake = fakeCaches();
        fake.faults.delete = fault;
        vi.stubGlobal("caches", fake.storage);
        await expect(m.forgetLinkAudio(freshLink())).resolves.toBeUndefined();
      },
    );

    it("resolves when there is no Cache Storage", async () => {
      const m = await load();
      vi.stubGlobal("caches", undefined);
      await expect(m.forgetLinkAudio(freshLink())).resolves.toBeUndefined();
    });

    it("writes nothing to the console", async () => {
      const m = await load();
      const fake = fakeCaches();
      fake.faults.delete = "reject";
      vi.stubGlobal("caches", fake.storage);
      const spies = (["log", "warn", "error", "info", "debug"] as const).map(
        (name) => vi.spyOn(console, name).mockImplementation(() => undefined),
      );
      await m.forgetLinkAudio(freshLink());
      await m.pruneLinkAudio(freshLink(), []);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      for (const spy of spies) spy.mockRestore();
    });
  });

  describe("a chunk still on its way when the link ends", () => {
    it("is returned to the caller and not written when its answer arrives after the forgetting", async () => {
      const m = await load();
      const fake = fakeCaches();
      vi.stubGlobal("caches", fake.storage);
      const answer = gate();
      const fetchSpy = stubFetch(answer.held());
      const token = freshLink();

      const pending = m.cachedFetchArrayBuffer(
        `share:${token}`,
        ref(0, "/x/0"),
      );
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
      await m.forgetLinkAudio(token);
      answer.open();

      expect((await pending).byteLength).toBe(3);
      expect(fake.calls.put).toBe(0);
      expect(fake.names()).toEqual([]);
    });

    it("leaves the link without a cache when the forgetting comes while the write waits", async () => {
      const m = await load();
      const fake = fakeCaches();
      const write = gate();
      fake.faults.put = write.held;
      vi.stubGlobal("caches", fake.storage);
      stubFetch();
      const token = freshLink();

      const pending = m.cachedFetchArrayBuffer(
        `share:${token}`,
        ref(0, "/x/0"),
      );
      await vi.waitFor(() => expect(fake.calls.put).toBe(1));
      await m.forgetLinkAudio(token);
      write.open();
      await pending;

      expect(fake.entries(`${m.LINK_AUDIO_PREFIX}${token}`)).toEqual([]);
      expect(fake.names()).toEqual([]);
    });

    it("leaves no empty cache when the forgetting comes while the cache is being opened", async () => {
      const m = await load();
      const fake = fakeCaches();
      const opening = gate();
      fake.faults.open = opening.held;
      vi.stubGlobal("caches", fake.storage);
      stubFetch();
      const token = freshLink();

      const pending = m.cachedFetchArrayBuffer(
        `share:${token}`,
        ref(0, "/x/0"),
      );
      await vi.waitFor(() => expect(fake.calls.open).toBe(1));
      await m.forgetLinkAudio(token);
      opening.open();
      await pending;

      expect(fake.names()).toEqual([]);
    });

    it("counts a later chunk of the same link as a new start, after a forgetting", async () => {
      const m = await load();
      const fake = fakeCaches();
      vi.stubGlobal("caches", fake.storage);
      stubFetch();
      const token = freshLink();
      await m.forgetLinkAudio(token);
      await m.cachedFetchArrayBuffer(`share:${token}`, ref(0, "/x/0"));
      expect(fake.entries(`${m.LINK_AUDIO_PREFIX}${token}`)).toHaveLength(1);
    });
  });

  it("does not read the cache for an ended link, and the request layer refuses it", async () => {
    const m = await load();
    const fake = fakeCaches();
    vi.stubGlobal("caches", fake.storage);
    const fetchSpy = stubFetch();
    const token = freshLink();
    await m.cachedFetchArrayBuffer(`share:${token}`, ref(0, "/x/0"));
    const reads = fake.calls.match;
    fetchSpy.mockClear();

    m.markLinkEnded(token);
    await expect(
      m.cachedFetchArrayBuffer(`share:${token}`, ref(0, "/x/0")),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(fake.calls.match).toBe(reads);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe("a cache that fails never fails the audio", () => {
    it.each<[Method, Fault]>([
      ["open", "throw"],
      ["open", "reject"],
      ["match", "throw"],
      ["match", "reject"],
      ["put", "throw"],
      ["put", "reject"],
      ["delete", "reject"],
    ])(
      "returns the bytes after one request when %s %s",
      async (method, fault) => {
        const m = await load();
        const fake = fakeCaches();
        fake.faults[method] = fault;
        vi.stubGlobal("caches", fake.storage);
        const fetchSpy = stubFetch();

        const bytes = await m.cachedFetchArrayBuffer(
          `share:${freshLink()}`,
          ref(0, "/x/0"),
        );

        expect(bytes.byteLength).toBe(3);
        expect(fetchSpy).toHaveBeenCalledOnce();
      },
    );

    it("treats a hit whose body cannot be read as a miss", async () => {
      const m = await load();
      const fake = fakeCaches();
      vi.stubGlobal("caches", fake.storage);
      const fetchSpy = stubFetch();
      const key = `share:${freshLink()}`;
      await m.cachedFetchArrayBuffer(key, ref(0, "/x/0"));
      fetchSpy.mockClear();
      const real = fake.storage.open.bind(fake.storage);
      vi.spyOn(fake.storage, "open").mockImplementation(async (name) => {
        const cache = await real(name);
        return {
          ...cache,
          match: async () =>
            ({
              arrayBuffer: () => Promise.reject(new Error("body gone")),
            }) as unknown as Response,
        };
      });

      const bytes = await m.cachedFetchArrayBuffer(key, ref(0, "/x/0"));

      expect(bytes.byteLength).toBe(3);
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it("keeps the request's own error when the fetch fails and the cache fails too", async () => {
      const m = await load();
      const fake = fakeCaches();
      fake.faults.put = "reject";
      fake.faults.delete = "reject";
      vi.stubGlobal("caches", fake.storage);
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response("gone", {
              status: 404,
              headers: { "X-Sharecut-Error-Code": "proxy_not_found" },
            }),
        ),
      );
      await expect(
        m.cachedFetchArrayBuffer(`share:${freshLink()}`, ref(0, "/x/0")),
      ).rejects.toMatchObject({ code: "proxy_not_found", status: 404 });
    });
  });

  describe("pruneLinkAudio", () => {
    it("keeps the named chunks, drops the rest and leaves another link alone", async () => {
      const m = await load();
      const fake = fakeCaches();
      vi.stubGlobal("caches", fake.storage);
      const fetchSpy = stubFetch();
      const token = freshLink();
      const other = freshLink();
      const key = `share:${token}`;
      const old = ref(0, "/x/0", "c".repeat(64));
      const current = [ref(0, "/y/0"), ref(1, "/y/1")];
      for (const chunk of [old, ...current])
        await m.cachedFetchArrayBuffer(key, chunk);
      await m.cachedFetchArrayBuffer(`share:${other}`, old);

      // A presigned URL is new on every read; the identity is what is kept.
      await m.pruneLinkAudio(
        token,
        current.map((chunk) => ({ ...chunk, url: `${chunk.url}?sig=2` })),
      );

      expect(fake.entries(`${m.LINK_AUDIO_PREFIX}${token}`)).toHaveLength(2);
      expect(fake.entries(`${m.LINK_AUDIO_PREFIX}${other}`)).toHaveLength(1);
      fetchSpy.mockClear();
      for (const chunk of current) await m.cachedFetchArrayBuffer(key, chunk);
      expect(fetchSpy).not.toHaveBeenCalled();
      await m.cachedFetchArrayBuffer(key, old);
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it("creates no cache and never rejects", async () => {
      const m = await load();
      const fake = fakeCaches();
      vi.stubGlobal("caches", fake.storage);
      await m.pruneLinkAudio(freshLink(), [ref(0, "/y/0")]);
      expect(fake.created).toEqual([]);

      for (const method of ["has", "open", "keys", "delete"] as const) {
        const broken = fakeCaches();
        broken.seed(`sharecut-link-audio:broken-${method}`);
        broken.faults[method] = "reject";
        vi.stubGlobal("caches", broken.storage);
        await expect(
          m.pruneLinkAudio(`broken-${method}`, []),
        ).resolves.toBeUndefined();
      }
      vi.stubGlobal("caches", undefined);
      await expect(m.pruneLinkAudio(freshLink(), [])).resolves.toBeUndefined();
    });

    it("leaves the link without a cache when it is forgotten while the prune waits", async () => {
      const m = await load();
      const fake = fakeCaches();
      vi.stubGlobal("caches", fake.storage);
      stubFetch();
      const token = freshLink();
      await m.cachedFetchArrayBuffer(`share:${token}`, ref(0, "/x/0"));
      const listing = gate();
      fake.faults.keys = listing.held;

      const pruning = m.pruneLinkAudio(token, []);
      await vi.waitFor(() => expect(fake.calls.keys).toBe(1));
      await m.forgetLinkAudio(token);
      listing.open();
      await pruning;

      expect(fake.names()).toEqual([]);
    });
  });

  it("drops the old shared cache the first time a link's audio is fetched", async () => {
    const m = await load();
    const fake = fakeCaches();
    fake.seed(LEGACY);
    vi.stubGlobal("caches", fake.storage);
    stubFetch();
    await m.cachedFetchArrayBuffer(`share:${freshLink()}`, ref(0, "/x/0"));
    await vi.waitFor(() => expect(fake.names()).not.toContain(LEGACY));
  });

  it("only fetches, touching no cache, when the key holds no share token", async () => {
    const m = await load();
    const fake = fakeCaches();
    vi.stubGlobal("caches", fake.storage);
    const fetchSpy = stubFetch();
    await m.cachedFetchArrayBuffer("/home/me/episode.json", ref(0, "/x/0"));
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fake.calls).toEqual({
      open: 0,
      match: 0,
      put: 0,
      delete: 0,
      keys: 0,
      has: 0,
    });
  });
});
