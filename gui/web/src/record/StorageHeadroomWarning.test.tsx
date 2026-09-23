import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { KEEPER_BYTES_PER_SECOND } from "./keeper/pcm";
import { StorageHeadroomWarning } from "./StorageHeadroomWarning";
import { STORAGE_HEADROOM_SECONDS } from "./storageQuota";
import { STORAGE_UNKNOWN_COPY, storageLowCopy } from "./types";

type Estimate = { usage?: number; quota?: number };

const plenty: Estimate = {
  usage: 0,
  quota: KEEPER_BYTES_PER_SECOND * STORAGE_HEADROOM_SECONDS * 2,
};

function stubStorage(estimate: (() => Promise<Estimate>) | null) {
  const mock = estimate ? vi.fn(estimate) : null;
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: mock ? { estimate: mock } : undefined,
  });
  return mock;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("StorageHeadroomWarning", () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, "storage");
  });

  it("keeps an empty live region while the estimate is pending", async () => {
    const pending = deferred<Estimate>();
    stubStorage(() => pending.promise);
    render(<StorageHeadroomWarning />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    pending.resolve({ usage: 0, quota: 1 });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(storageLowCopy(0)),
    );
  });

  it("stays silent with enough headroom", async () => {
    const estimate = stubStorage(async () => plenty);
    render(<StorageHeadroomWarning />);
    await waitFor(() => expect(estimate).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("reports unknown when estimate() rejects", async () => {
    stubStorage(async () => {
      throw new Error("denied");
    });
    render(<StorageHeadroomWarning />);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        STORAGE_UNKNOWN_COPY,
      ),
    );
  });

  it("reports unknown when navigator.storage is missing", async () => {
    stubStorage(null);
    render(<StorageHeadroomWarning />);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        STORAGE_UNKNOWN_COPY,
      ),
    );
  });

  it("hides the text but keeps the region when not visible", async () => {
    const estimate = stubStorage(async () => ({ usage: 0, quota: 1 }));
    render(<StorageHeadroomWarning visible={false} />);
    await waitFor(() => expect(estimate).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("passes axe in the warning state", async () => {
    stubStorage(async () => ({ usage: 0, quota: 1 }));
    const { container } = render(<StorageHeadroomWarning />);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(storageLowCopy(0)),
    );
    await expectNoA11yViolations(container);
  });

  it("commits only the latest estimate when refreshes overlap", async () => {
    const first = deferred<Estimate>();
    const second = deferred<Estimate>();
    const queue = [first.promise, second.promise];
    const estimate = stubStorage(
      () => queue.shift() ?? Promise.resolve(plenty),
    );
    const { rerender } = render(<StorageHeadroomWarning recheck={false} />);
    rerender(<StorageHeadroomWarning recheck />);
    await waitFor(() => expect(estimate).toHaveBeenCalledTimes(2));
    second.resolve(plenty);
    await Promise.resolve();
    first.resolve({ usage: 0, quota: 1 });
    await first.promise;
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
});
