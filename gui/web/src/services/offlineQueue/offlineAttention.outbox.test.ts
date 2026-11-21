import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendOutbox } from "../../state/outboxStore";
import { stubIndexedDb } from "../../test/fakeIndexedDb";
import { offlineConflict } from "../../test/fixtures";
import {
  refreshOfflineAttention,
  useOfflineAttention,
} from "./offlineAttention";

const rows = new Map<string, unknown>();

beforeEach(() => {
  rows.clear();
  stubIndexedDb(rows);
});
afterEach(() => vi.unstubAllGlobals());

it("counts a guest's kept comments and replies as waiting, with the edits", async () => {
  const kept = (n: number) => ({
    id: n.toString(16).padStart(32, "0"),
    kind: "reply" as const,
    body: "hi",
    author: "Ana",
    created_at: n,
    parent_comment_id: "c1",
  });
  await appendOutbox("tok", kept(1));
  await appendOutbox("tok", kept(2));
  const { result } = renderHook(() => useOfflineAttention("share:tok"));
  await vi.waitFor(() => expect(result.current.loaded).toBe(true));
  expect(result.current.pending).toBe(0);
  expect(result.current.waitingPosts).toBe(2);
  expect(result.current.status).toBe("ready");
  await act(async () => {});
});

it("reads an unreadable outbox as saved edits that could not be read", async () => {
  rows.set("outbox:tok", "damaged");
  const { result } = renderHook(() => useOfflineAttention("share:tok"));
  await vi.waitFor(() => expect(result.current.status).toBe("unreadable"));
});

it("keeps a guest retry out of conflicts only while its command is queued", async () => {
  const refused = offlineConflict({ command: { command_id: "refused" } });
  const retry = {
    ...offlineConflict({ command: { command_id: "retry" } }),
    kind: "unknown",
    recovery: "retry-same-command",
  };
  rows.set("queue:tok", [retry.command]);
  rows.set("conflicts:tok", [retry, refused]);
  const { result } = renderHook(() => useOfflineAttention("share:tok"));
  await vi.waitFor(() => expect(result.current.loaded).toBe(true));
  expect(result.current.pending).toBe(1);
  expect(result.current.conflicts).toEqual([refused]);

  rows.set("queue:tok", []);
  await act(async () => refreshOfflineAttention("share:tok"));
  expect(result.current.pending).toBe(0);
  expect(result.current.conflicts).toEqual([retry, refused]);
});
