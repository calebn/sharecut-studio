import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READY, STALE } from "./feedFixture";
import type { FeedView, Served } from "../../types/feedView";
import { useFeed } from "./useFeed";

const submit = vi.hoisted(() => vi.fn());
vi.mock("../../api/documentEdits", () => ({ submitDocumentCommand: submit }));

const HOST = "/projects/ep.sharecut";
const TOKEN = "share:abc";

const served = (view: FeedView): Served => ({ view, itemXml: "<item/>" });
const reply = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
const refusal = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ detail: message }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Sharecut-Error-Code": code,
    },
  });

const fetchMock =
  vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

const calls = () =>
  fetchMock.mock.calls.map(([url, init]) => ({
    url,
    method: init?.method ?? "GET",
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
  }));

function titled(
  view: FeedView,
  value: string,
  by: "person" | "guest" = "person",
) {
  return {
    ...view,
    item: {
      ...view.item,
      "item.title": {
        value,
        source: { kind: "pinned" as const, by, drifted: false },
      },
    },
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  submit.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useFeed as the host", () => {
  it("loads the listing from the host route", async () => {
    fetchMock.mockResolvedValueOnce(reply(served(READY)));
    const { result } = renderHook(() => useFeed(HOST, { access: "host" }));
    expect(result.current.load).toBe("loading");
    await waitFor(() => expect(result.current.load).toBe("ready"));
    expect(result.current.served?.view.file).toBe("current");
    expect(calls()[0]).toMatchObject({
      url: `/api/feed?path=${encodeURIComponent(HOST)}`,
      method: "GET",
    });
  });

  it("says why the listing did not load", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    const { result } = renderHook(() => useFeed(HOST, { access: "host" }));
    await waitFor(() => expect(result.current.load).toBe("error"));
    expect(result.current.problem).toBe(
      "Couldn't reach the server. Check your connection and try again.",
    );
  });

  it("shows a set value at once and then the service's own view", async () => {
    fetchMock.mockResolvedValueOnce(reply(served(READY)));
    const { result } = renderHook(() => useFeed(HOST, { access: "host" }));
    await waitFor(() => expect(result.current.load).toBe("ready"));
    let answer: (response: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    act(() =>
      result.current.act({
        kind: "edit",
        edit: { op: "set", key: "item.title", value: "New name" },
      }),
    );
    expect(result.current.served?.view.item["item.title"]).toEqual({
      value: "New name",
      source: { kind: "pinned", by: "person", drifted: false },
    });
    await act(async () =>
      answer(reply(served(titled(READY, "New name (trimmed)")))),
    );
    await waitFor(() =>
      expect(result.current.served?.view.item["item.title"]?.value).toBe(
        "New name (trimmed)",
      ),
    );
    expect(calls()[1]).toEqual({
      url: "/api/feed/edit",
      method: "POST",
      body: {
        path: HOST,
        edit: { op: "set", key: "item.title", value: "New name" },
        by: "person",
      },
    });
  });

  it("puts the service's view back and names the refusal when an edit fails", async () => {
    fetchMock.mockResolvedValueOnce(reply(served(READY)));
    const { result } = renderHook(() => useFeed(HOST, { access: "host" }));
    await waitFor(() => expect(result.current.load).toBe("ready"));
    fetchMock.mockResolvedValueOnce(
      refusal(
        400,
        "feed_value_invalid",
        "The address must start with https://.",
      ),
    );
    act(() =>
      result.current.act({
        kind: "edit",
        edit: { op: "set", key: "item.title", value: "Nope" },
      }),
    );
    await waitFor(() =>
      expect(result.current.problem).toBe(
        "The address must start with https://.",
      ),
    );
    expect(result.current.served?.view).toEqual(READY);
    act(() => result.current.dismissProblem());
    expect(result.current.problem).toBeNull();
  });

  it("sends edits one at a time and keeps a later one on screen while an earlier answers", async () => {
    fetchMock.mockResolvedValueOnce(reply(served(READY)));
    const { result } = renderHook(() => useFeed(HOST, { access: "host" }));
    await waitFor(() => expect(result.current.load).toBe("ready"));
    let first: (response: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise((resolve) => (first = resolve)));
    fetchMock.mockResolvedValueOnce(reply(served(titled(READY, "Two"))));
    act(() => {
      result.current.act({
        kind: "edit",
        edit: { op: "set", key: "item.title", value: "One" },
      });
      result.current.act({
        kind: "edit",
        edit: { op: "set", key: "item.title", value: "Two" },
      });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(result.current.served?.view.item["item.title"]?.value).toBe("Two");
    await act(async () => first(reply(served(titled(READY, "One")))));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(result.current.served?.view.item["item.title"]?.value).toBe("Two"),
    );
  });

  it("writes the feed file and clears the request", async () => {
    fetchMock.mockResolvedValueOnce(reply(served(STALE)));
    const { result } = renderHook(() => useFeed(HOST, { access: "host" }));
    await waitFor(() => expect(result.current.load).toBe("ready"));
    fetchMock.mockResolvedValueOnce(reply(served(READY)));
    act(() => result.current.act({ kind: "command", command: "write_feed" }));
    expect(result.current.request).toBe("writing");
    await waitFor(() => expect(result.current.request).toBeUndefined());
    expect(result.current.served?.view.file).toBe("current");
    expect(calls()[1]).toEqual({
      url: "/api/feed/write",
      method: "POST",
      body: { path: HOST },
    });
  });

  it("reports a refused write in plain words and offers another try", async () => {
    fetchMock.mockResolvedValueOnce(reply(served(STALE)));
    const { result } = renderHook(() => useFeed(HOST, { access: "host" }));
    await waitFor(() => expect(result.current.load).toBe("ready"));
    fetchMock.mockResolvedValueOnce(
      refusal(400, "feed_write_refused", "1 blocker stands."),
    );
    act(() => result.current.act({ kind: "command", command: "write_feed" }));
    await waitFor(() => expect(result.current.request).toBe("failed"));
    expect(result.current.problem).toBe("1 blocker stands.");
    expect(result.current.served?.view.file).toBe("stale");
  });

  it("names the code's own words for a blocked feed", async () => {
    fetchMock.mockResolvedValueOnce(reply(served(STALE)));
    const { result } = renderHook(() => useFeed(HOST, { access: "host" }));
    await waitFor(() => expect(result.current.load).toBe("ready"));
    fetchMock.mockResolvedValueOnce(
      refusal(400, "feed_blocked", "feed_blocked: item.title"),
    );
    act(() => result.current.act({ kind: "command", command: "write_feed" }));
    await waitFor(() =>
      expect(result.current.problem).toBe(
        "Fix the blockers in Checks first, then write the feed file.",
      ),
    );
  });

  it("creates and links a show as a set of the show", async () => {
    fetchMock.mockResolvedValueOnce(reply(served(READY)));
    const { result } = renderHook(() => useFeed(HOST, { access: "host" }));
    await waitFor(() => expect(result.current.load).toBe("ready"));
    fetchMock.mockResolvedValue(reply(served(READY)));
    act(() =>
      result.current.act({
        kind: "command",
        command: "create_show",
        args: { title: "The Long River" },
      }),
    );
    act(() =>
      result.current.act({
        kind: "command",
        command: "link_show",
        args: { id: "field-notes" },
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(
      calls()
        .slice(1)
        .map((c) => c.body.edit),
    ).toEqual([
      { op: "set", key: "show", value: "The Long River" },
      { op: "set", key: "show", value: "field-notes", link: true },
    ]);
  });

  it("hands other commands to the app", async () => {
    fetchMock.mockResolvedValueOnce(reply(served(READY)));
    const onCommand = vi.fn();
    const { result } = renderHook(() =>
      useFeed(HOST, { access: "host", onCommand }),
    );
    await waitFor(() => expect(result.current.load).toBe("ready"));
    act(() =>
      result.current.act({ kind: "command", command: "export_episode" }),
    );
    expect(onCommand).toHaveBeenCalledWith({
      kind: "command",
      command: "export_episode",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never lets a read that started during an edit put the old value back", async () => {
    fetchMock.mockResolvedValueOnce(reply(served(READY)));
    const { result, rerender } = renderHook(
      ({ key }) => useFeed(HOST, { access: "host", refreshKey: key }),
      { initialProps: { key: "a" } },
    );
    await waitFor(() => expect(result.current.load).toBe("ready"));
    let answerEdit: (response: Response) => void = () => {};
    let answerRead: (response: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => (answerEdit = resolve)),
    );
    await act(async () =>
      result.current.act({
        kind: "edit",
        edit: { op: "set", key: "item.title", value: "Pinned" },
      }),
    );
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => (answerRead = resolve)),
    );
    rerender({ key: "b" });
    await act(async () => answerEdit(reply(served(titled(READY, "Pinned")))));
    await act(async () => answerRead(reply(served(READY))));
    expect(result.current.served?.view.item["item.title"]?.value).toBe(
      "Pinned",
    );
  });

  it("sends the original author when an undo restores a pin", async () => {
    fetchMock.mockResolvedValueOnce(reply(served(READY)));
    const { result } = renderHook(() => useFeed(HOST, { access: "host" }));
    await waitFor(() => expect(result.current.load).toBe("ready"));
    fetchMock.mockResolvedValueOnce(reply(served(titled(READY, "Mine"))));
    act(() =>
      result.current.act({
        kind: "edit",
        edit: { op: "set", key: "item.title", value: "Mine" },
        by: "agent",
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(calls()[1].body.by).toBe("agent");
    expect(
      result.current.served?.view.item["item.title"]?.source,
    ).toMatchObject({ by: "person" });
  });

  it("reads again without blanking when the refresh key changes", async () => {
    fetchMock.mockResolvedValueOnce(reply(served(STALE)));
    const { result, rerender } = renderHook(
      ({ key }) => useFeed(HOST, { access: "host", refreshKey: key }),
      { initialProps: { key: "a" } },
    );
    await waitFor(() => expect(result.current.load).toBe("ready"));
    fetchMock.mockResolvedValueOnce(reply(served(READY)));
    rerender({ key: "b" });
    expect(result.current.load).toBe("ready");
    await waitFor(() =>
      expect(result.current.served?.view.file).toBe("current"),
    );
  });

  it("keeps what it has when a quiet refresh fails", async () => {
    fetchMock.mockResolvedValueOnce(reply(served(READY)));
    const { result } = renderHook(() => useFeed(HOST, { access: "host" }));
    await waitFor(() => expect(result.current.load).toBe("ready"));
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.problem).not.toBeNull());
    expect(result.current.load).toBe("ready");
    expect(result.current.served?.view).toEqual(READY);
  });
});

describe("useFeed as a link that may not edit", () => {
  it("drops an edit a viewer link may not send and says why", async () => {
    fetchMock.mockResolvedValueOnce(reply(served(READY)));
    const { result } = renderHook(() => useFeed(TOKEN, { access: "viewer" }));
    await waitFor(() => expect(result.current.load).toBe("ready"));
    act(() =>
      result.current.act({
        kind: "edit",
        edit: { op: "set", key: "item.title", value: "A" },
      }),
    );
    expect(calls()).toHaveLength(1);
    expect(result.current.problem).toBe(
      "This link can read the listing but not change it.",
    );
  });
});

describe("useFeed as a guest", () => {
  it("reads the listing through the review route", async () => {
    fetchMock.mockResolvedValueOnce(reply(served(READY)));
    const { result } = renderHook(() => useFeed(TOKEN, { access: "editor" }));
    await waitFor(() => expect(result.current.load).toBe("ready"));
    expect(calls()[0].url).toBe("/api/review/abc/feed");
  });

  it("sends a show value through the guest feed route and marks it as a guest's", async () => {
    fetchMock.mockResolvedValueOnce(reply(served(READY)));
    const { result } = renderHook(() => useFeed(TOKEN, { access: "editor" }));
    await waitFor(() => expect(result.current.load).toBe("ready"));
    let answer: (response: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    act(() =>
      result.current.act({
        kind: "edit",
        edit: { op: "set", key: "channel.author", value: "Ana" },
      }),
    );
    expect(result.current.served?.view.channel["channel.author"]).toEqual({
      value: "Ana",
      source: { kind: "pinned", by: "guest", drifted: false },
    });
    await act(async () => answer(reply(served(READY))));
    await waitFor(() =>
      expect(
        result.current.served?.view.channel["channel.author"],
      ).toBeUndefined(),
    );
    expect(calls()[1]).toEqual({
      url: "/api/review/abc/feed/edit",
      method: "POST",
      body: { edit: { op: "set", key: "channel.author", value: "Ana" } },
    });
  });

  it("sends an episode value as a document command and reads the listing again", async () => {
    fetchMock.mockResolvedValueOnce(reply(served(READY)));
    const { result } = renderHook(() => useFeed(TOKEN, { access: "editor" }));
    await waitFor(() => expect(result.current.load).toBe("ready"));
    submit.mockResolvedValue({});
    fetchMock.mockResolvedValueOnce(
      reply(served(titled(READY, "Ana's", "guest"))),
    );
    act(() =>
      result.current.act({
        kind: "edit",
        edit: { op: "set", key: "item.title", value: "Ana's" },
      }),
    );
    await waitFor(() =>
      expect(result.current.served?.view.item["item.title"]?.source).toEqual({
        kind: "pinned",
        by: "guest",
        drifted: false,
      }),
    );
    expect(submit).toHaveBeenCalledWith(TOKEN, "SetFeedField", {
      key: "item.title",
      value: "Ana's",
    });
    expect(calls()[1].url).toBe("/api/review/abc/feed");
  });

  it("keeps the preview while the command queue holds the edit, and drops it once the head moves", async () => {
    fetchMock.mockResolvedValueOnce(reply(served(READY)));
    const { result, rerender } = renderHook(
      ({ key }) => useFeed(TOKEN, { access: "editor", refreshKey: key }),
      { initialProps: { key: "a" } },
    );
    await waitFor(() => expect(result.current.load).toBe("ready"));
    submit.mockResolvedValue({ ok: true, queued: true });
    act(() =>
      result.current.act({
        kind: "edit",
        edit: { op: "set", key: "item.title", value: "Waiting" },
      }),
    );
    await waitFor(() => expect(submit).toHaveBeenCalled());
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.served?.view.item["item.title"]).toEqual({
      value: "Waiting",
      source: { kind: "pinned", by: "guest", drifted: false },
    });
    fetchMock.mockResolvedValueOnce(
      reply(served(titled(READY, "Waiting", "guest"))),
    );
    rerender({ key: "b" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(result.current.served?.view.item["item.title"]?.value).toBe(
      "Waiting",
    );
    fetchMock.mockResolvedValueOnce(reply(served(READY)));
    rerender({ key: "c" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await act(async () => {});
    expect(result.current.served?.view.item["item.title"]).toEqual(
      READY.item["item.title"],
    );
  });

  it("clears an episode value with the clear command", async () => {
    fetchMock.mockResolvedValueOnce(reply(served(READY)));
    const { result } = renderHook(() => useFeed(TOKEN, { access: "editor" }));
    await waitFor(() => expect(result.current.load).toBe("ready"));
    submit.mockResolvedValue({});
    fetchMock.mockResolvedValueOnce(reply(served(READY)));
    act(() =>
      result.current.act({
        kind: "edit",
        edit: { op: "unset", key: "item.intro" },
      }),
    );
    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(submit).toHaveBeenCalledWith(TOKEN, "ClearFeedField", {
      key: "item.intro",
    });
  });

  it("tells a person the host owns a setting the service refuses (server backstop)", async () => {
    fetchMock.mockResolvedValueOnce(reply(served(READY)));
    const { result } = renderHook(() => useFeed(HOST, { access: "host" }));
    await waitFor(() => expect(result.current.load).toBe("ready"));
    fetchMock.mockResolvedValueOnce(
      refusal(
        403,
        "share_capability_required",
        "That setting is changed by the host",
      ),
    );
    act(() =>
      result.current.act({
        kind: "edit",
        edit: {
          op: "set",
          key: "channel.mediaUrl",
          value: "https://x.test/{file}",
        },
      }),
    );
    await waitFor(() =>
      expect(result.current.problem).toBe(
        "That setting is changed by the host.",
      ),
    );
  });

  it("writes the feed file through the guest route", async () => {
    fetchMock.mockResolvedValueOnce(reply(served(STALE)));
    const { result } = renderHook(() => useFeed(TOKEN, { access: "editor" }));
    await waitFor(() => expect(result.current.load).toBe("ready"));
    fetchMock.mockResolvedValueOnce(reply(served(READY)));
    act(() => result.current.act({ kind: "command", command: "write_feed" }));
    await waitFor(() => expect(result.current.request).toBeUndefined());
    expect(calls()[1]).toMatchObject({
      url: "/api/review/abc/feed/write",
      method: "POST",
    });
  });
});
