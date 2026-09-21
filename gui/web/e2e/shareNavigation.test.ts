import { expect, it } from "vitest";
import { openGuestShare } from "./shareNavigation";

it("preserves navigation failure while observing a failed manifest wait", async () => {
  const navigationError = new Error("navigation failed");
  const manifestError = new Error("manifest wait failed");
  let rejectManifest!: (error: Error) => void;
  const page = {
    waitForResponse: () =>
      new Promise<never>((_, reject) => {
        rejectManifest = reject;
      }),
    goto: async () => {
      throw navigationError;
    },
  };

  await expect(openGuestShare(page as never, "token")).rejects.toBe(
    navigationError,
  );
  rejectManifest(manifestError);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
});
