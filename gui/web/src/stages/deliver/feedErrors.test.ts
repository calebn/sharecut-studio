import { describe, expect, it } from "vitest";
import { ApiError } from "../../utils/apiError";
import { feedErrorText } from "./feedErrors";

const refused = (message: string, code: string) =>
  new ApiError(message, code, 400);

describe("feedErrorText", () => {
  it("names a field by its label, never its key", () => {
    expect(
      feedErrorText(
        refused(
          "item.enclosure.url must be an https address",
          "feed_value_invalid",
        ),
      ),
    ).toBe("hosting address must be an https address");
  });

  it("says the value is not valid when a guest gets only the generic line", () => {
    expect(
      feedErrorText(
        refused(
          "That didn't work; ask the host to check this episode.",
          "feed_value_invalid",
        ),
      ),
    ).toBe("That value isn't valid for this field.");
  });

  it.each([
    "feed_show_unknown",
    "feed_field_edit_at_source",
    "feed_field_not_editable",
  ])("has words for %s", (code) => {
    expect(feedErrorText(refused("channel.title boom", code))).not.toContain(
      "channel.",
    );
  });
});
