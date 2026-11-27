import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../utils/apiError";
import { apiFetch, HOST_KEY } from "./http";
import { dropInboxFile, fetchInboxFile } from "./inbox";

vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  apiFetch: vi.fn(),
}));

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe("fetchInboxFile", () => {
  it("reads the bytes into a File with the name it was given", async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response("abc"));
    const file = await fetchInboxFile(ID, "Warm bed.sharecutseg");
    expect(apiFetch).toHaveBeenCalledWith(
      HOST_KEY,
      { host: `/api/import/inbox/${ID}` },
      { signal: undefined },
    );
    expect(file.name).toBe("Warm bed.sharecutseg");
    expect(file).toBeInstanceOf(File);
  });

  it("passes a refusal through", async () => {
    vi.mocked(apiFetch).mockRejectedValue(
      new ApiError("That file can't be found.", "import_inbox_unknown", 404),
    );
    await expect(fetchInboxFile(ID, "a.sharecutseg")).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("dropInboxFile", () => {
  it("deletes the received copy", async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response("{}"));
    await dropInboxFile(ID);
    expect(apiFetch).toHaveBeenCalledWith(
      HOST_KEY,
      { host: `/api/import/inbox/${ID}` },
      { method: "DELETE" },
    );
  });
});
