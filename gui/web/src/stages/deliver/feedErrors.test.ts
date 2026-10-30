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

  it("shows the service's sentence as written", () => {
    expect(
      feedErrorText(
        refused(
          "Hosting address must be an https address.",
          "feed_value_invalid",
        ),
      ),
    ).toBe("Hosting address must be an https address.");
  });

  it("falls back when the refusal carries no words", () => {
    expect(feedErrorText(refused("", "feed_value_invalid"))).toBe(
      "That value isn't valid for this field.",
    );
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
