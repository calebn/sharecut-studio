import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isChunkLoadError, RoomLoadBoundary } from "./RoomLoadBoundary";

function Thrower({ error }: { error: Error }): never {
  throw error;
}

function chunkError(): Error {
  return new TypeError(
    "Failed to fetch dynamically imported module: https://x.test/assets/GuestRoomApp-abc.js",
  );
}

describe("RoomLoadBoundary", () => {
  let reload: ReturnType<typeof vi.fn>;
  let logged: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    document.title = "before";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders its children when nothing throws", () => {
    render(
      <RoomLoadBoundary>
        <p>The room</p>
      </RoomLoadBoundary>,
    );
    expect(screen.getByText("The room")).toBeInTheDocument();
  });

  it("covers a failed room chunk with the network copy, a Reload button and the tab title", () => {
    render(
      <RoomLoadBoundary>
        <Thrower error={chunkError()} />
      </RoomLoadBoundary>,
    );
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Couldn't reach the room",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Check your internet connection, then try again/),
    ).toBeInTheDocument();
    expect(document.title).toBe("Couldn't reach the room | ShareCut Studio");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalled();
  });

  it("covers any other error with its own words and title, never the network copy", () => {
    render(
      <RoomLoadBoundary>
        <Thrower error={new Error("undefined is not a function")} />
      </RoomLoadBoundary>,
    );
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Something went wrong with the room",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/internet connection/)).toBeNull();
    expect(document.title).toBe(
      "Something went wrong with the room | ShareCut Studio",
    );
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(logged).toHaveBeenCalled();
  });

  it("recognises the chunk failures of each browser", () => {
    expect(isChunkLoadError(chunkError())).toBe(true);
    expect(
      isChunkLoadError(new TypeError("Importing a module script failed.")),
    ).toBe(true);
    expect(
      isChunkLoadError(
        new TypeError("error loading dynamically imported module: /a.js"),
      ),
    ).toBe(true);
    const named = new Error("boom");
    named.name = "ChunkLoadError";
    expect(isChunkLoadError(named)).toBe(true);
    expect(isChunkLoadError(new Error("nope"))).toBe(false);
    expect(
      isChunkLoadError("Failed to fetch dynamically imported module"),
    ).toBe(false);
  });
});
