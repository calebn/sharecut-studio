import { describe, expect, it, vi } from "vitest";
import { assertSafePart, opfsDirHandle, opfsFileHandle } from "./opfsPath";

function fakeDir() {
  const dir = {
    getDirectoryHandle: vi.fn(async (_name: string, _o?: unknown) => dir),
    getFileHandle: vi.fn(async (name: string, _o?: unknown) => ({ name })),
  };
  return dir;
}

const asRoot = (d: ReturnType<typeof fakeDir>) =>
  d as unknown as FileSystemDirectoryHandle;

describe("assertSafePart", () => {
  it.each(["", ".", "..", "a/b", "a\\b"])("rejects %j", (part) => {
    expect(() => assertSafePart(part)).toThrow(/invalid keeper path part/);
  });

  it("returns a safe part unchanged", () => {
    expect(assertSafePart("0.wav")).toBe("0.wav");
  });
});

describe("opfsDirHandle", () => {
  it("walks the parts in order with the create flag", async () => {
    const dir = fakeDir();
    await opfsDirHandle(asRoot(dir), ["a", "b"], true);
    expect(dir.getDirectoryHandle.mock.calls).toEqual([
      ["a", { create: true }],
      ["b", { create: true }],
    ]);
  });

  it("rejects a traversal part before walking into it", async () => {
    const dir = fakeDir();
    await expect(
      opfsDirHandle(asRoot(dir), ["a", ".."], false),
    ).rejects.toThrow(/invalid keeper path part/);
    expect(dir.getDirectoryHandle).toHaveBeenCalledTimes(1);
  });
});

describe("opfsFileHandle", () => {
  it("walks directories and opens the file", async () => {
    const dir = fakeDir();
    await opfsFileHandle(asRoot(dir), "a/b/0.wav", true);
    expect(dir.getDirectoryHandle.mock.calls).toEqual([
      ["a", { create: true }],
      ["b", { create: true }],
    ]);
    expect(dir.getFileHandle).toHaveBeenCalledWith("0.wav", { create: true });
  });

  it("rejects traversal and empty paths", async () => {
    const dir = fakeDir();
    await expect(
      opfsFileHandle(asRoot(dir), "a/../0.wav", true),
    ).rejects.toThrow(/invalid keeper path part/);
    await expect(opfsFileHandle(asRoot(dir), "a/..", true)).rejects.toThrow(
      /invalid keeper path part/,
    );
    await expect(opfsFileHandle(asRoot(dir), "", true)).rejects.toThrow(
      /invalid keeper path/,
    );
  });
});
