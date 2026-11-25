import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyStorageError,
  getStorageHealth,
  PREFS_SENTENCE,
  reportStorageFailure,
  reportStorageOk,
  resetStorageHealth,
  STORAGE_LIGHT,
  storageSentence,
  subscribeStorageHealth,
} from "./storageHealth";

const named = (name: string, code = 0) =>
  Object.assign(new Error(name), { name, code });

describe("classifyStorageError", () => {
  it.each([
    ["QuotaExceededError", named("QuotaExceededError", 22)],
    ["Firefox NS_ERROR_DOM_QUOTA_REACHED", named("NS_ERROR_DOM_QUOTA_REACHED")],
    ["legacy code 22", Object.assign(new Error("full"), { code: 22 })],
    ["legacy code 1014", Object.assign(new Error("full"), { code: 1014 })],
    ["a DOMException", new DOMException("full", "QuotaExceededError")],
  ])("calls %s full", (_name, error) => {
    expect(classifyStorageError(error)).toBe("full");
  });

  it.each([
    ["SecurityError", new DOMException("no", "SecurityError")],
    ["InvalidStateError", new DOMException("no", "InvalidStateError")],
  ])("calls %s blocked", (_name, error) => {
    expect(classifyStorageError(error)).toBe("blocked");
  });

  it("calls anything else other, including values that are not errors", () => {
    expect(classifyStorageError(named("AbortError"))).toBe("other");
    expect(classifyStorageError(new Error("bad data"))).toBe("other");
    expect(classifyStorageError("nope")).toBe("other");
    expect(classifyStorageError(undefined)).toBe("other");
  });
});

describe("storage health", () => {
  beforeEach(() => resetStorageHealth());

  it("holds a failed write until a write works, whatever reads say", () => {
    reportStorageFailure("queue", named("QuotaExceededError", 22), "write");
    reportStorageOk("queue", "read");
    expect(getStorageHealth()).toEqual({ queue: "full" });
    reportStorageOk("queue", "write");
    expect(getStorageHealth()).toEqual({});
  });

  it("lets a read that works clear a failed read", () => {
    reportStorageFailure("queue", named("SecurityError"), "read");
    reportStorageOk("queue", "read");
    expect(getStorageHealth()).toEqual({});
  });

  it("says nothing until something fails", () => {
    expect(getStorageHealth()).toEqual({});
  });

  it("surfaces a blocked or full failure on the first one, per area", () => {
    reportStorageFailure("snapshot", named("SecurityError"));
    reportStorageFailure("queue", named("QuotaExceededError", 22));
    expect(getStorageHealth()).toEqual({ snapshot: "blocked", queue: "full" });
  });

  it("changes once however often the same failure repeats", () => {
    const listener = vi.fn();
    subscribeStorageHealth(listener);
    for (let i = 0; i < 5; i++)
      reportStorageFailure("snapshot", named("QuotaExceededError", 22));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getStorageHealth()).toEqual({ snapshot: "full" });
  });

  it("keeps the same snapshot object while nothing changed", () => {
    reportStorageFailure("snapshot", named("SecurityError"));
    const before = getStorageHealth();
    reportStorageFailure("snapshot", named("SecurityError"));
    expect(getStorageHealth()).toBe(before);
  });

  it("surfaces another kind of failure only on the second one in a row", () => {
    const listener = vi.fn();
    subscribeStorageHealth(listener);
    reportStorageFailure("snapshot", named("AbortError"));
    expect(getStorageHealth()).toEqual({});
    expect(listener).not.toHaveBeenCalled();
    reportStorageFailure("snapshot", named("AbortError"));
    expect(getStorageHealth()).toEqual({ snapshot: "blocked" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not count another kind of failure across a success", () => {
    reportStorageFailure("snapshot", named("AbortError"));
    reportStorageOk("snapshot");
    reportStorageFailure("snapshot", named("AbortError"));
    expect(getStorageHealth()).toEqual({});
  });

  it("clears an area on one success and leaves the others", () => {
    reportStorageFailure("snapshot", named("SecurityError"));
    reportStorageFailure("queue", named("SecurityError"));
    reportStorageOk("snapshot");
    expect(getStorageHealth()).toEqual({ queue: "blocked" });
    const listener = vi.fn();
    subscribeStorageHealth(listener);
    reportStorageOk("snapshot");
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("the words", () => {
  it("names what is not kept and what still works, without storage jargon", () => {
    expect(STORAGE_LIGHT).toBe("Not kept on this device");
    expect(storageSentence("blocked")).toBe(
      "Your browser isn't letting this page keep a saved copy. The page still works while the host answers. If the host stops, what you write here is lost when you close the page.",
    );
    expect(storageSentence("full")).toBe(
      "This device has no room to keep a saved copy. The page still works while the host answers. If the host stops, what you write here is lost when you close the page.",
    );
    expect(PREFS_SENTENCE).toBe(
      "This browser isn't keeping your settings. They reset when you reload.",
    );
    for (const words of [
      STORAGE_LIGHT,
      storageSentence("blocked"),
      storageSentence("full"),
      PREFS_SENTENCE,
    ])
      expect(words).not.toMatch(
        /indexeddb|quota|storage|sync|error|offline mode/i,
      );
  });
});
