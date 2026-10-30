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
        "host",
      ),
    ).toBe("episode hosting address must be an https address");
  });

  it("shows the service's sentence as written", () => {
    expect(
      feedErrorText(
        refused(
          "Hosting address must be an https address.",
          "feed_value_invalid",
        ),
        "host",
      ),
    ).toBe("Hosting address must be an https address.");
  });

  it("falls back when the refusal carries no words", () => {
    expect(feedErrorText(refused("", "feed_value_invalid"), "host")).toBe(
      "That value isn't valid for this field.",
    );
  });

  it.each([
    "feed_show_unknown",
    "feed_field_edit_at_source",
    "feed_field_not_editable",
  ])("has words for %s", (code) => {
    expect(
      feedErrorText(refused("channel.title boom", code), "editor"),
    ).not.toContain("channel.");
  });

  it("tells the host to close what holds the export folder", () => {
    expect(feedErrorText(refused("", "feed_write_failed"), "host")).toContain(
      "export folder",
    );
  });

  it("gives an Editor advice they can act on, not the host's folder", () => {
    const text = feedErrorText(refused("", "feed_write_failed"), "editor");
    expect(text).toContain("Ask the host");
    expect(text).not.toContain("export folder");
  });
});
