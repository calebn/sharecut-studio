import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blockStorage } from "../test/blockStorage";
import { documentClientId, nextDocumentClientSeq } from "./documentClient";

const key = "daw_document_client_seq";
beforeEach(() => sessionStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("document client counter", () => {
  it("advances the persisted counter under its exact key", () => {
    sessionStorage.setItem(key, "41");
    expect(nextDocumentClientSeq()).toBe(42);
    expect(sessionStorage.getItem(key)).toBe("42");
  });

  it("rejects a corrupt counter without changing it", () => {
    sessionStorage.setItem(key, "41tail");
    expect(() => nextDocumentClientSeq()).toThrow();
    expect(sessionStorage.getItem(key)).toBe("41tail");
  });

  it("keeps one client id per tab under daw_client_id", () => {
    const id = documentClientId();
    expect(id).toMatch(/^viewer-[0-9a-f]{8}$/);
    expect(sessionStorage.getItem("daw_client_id")).toBe(id);
    expect(documentClientId()).toBe(id);
  });

  it("reuses an id already saved for the tab", () => {
    sessionStorage.setItem("daw_client_id", "viewer-saved");
    expect(documentClientId()).toBe("viewer-saved");
  });

  it("keeps one client id for the page load when storage is blocked", () => {
    blockStorage();
    const id = documentClientId();
    expect(id).toMatch(/^viewer-[0-9a-f]{8}$/);
    expect(documentClientId()).toBe(id);
  });

  it("degrades instead of throwing when storage is blocked", () => {
    blockStorage();
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const first = nextDocumentClientSeq();
    expect(first).toBe(1_700_000_000_001);
    expect(nextDocumentClientSeq()).toBe(first + 1);
  });
});
