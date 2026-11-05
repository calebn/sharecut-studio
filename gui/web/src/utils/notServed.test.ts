import { afterEach, describe, expect, it } from "vitest";
import { NOT_SERVED_ELEMENT_ID, readNotServed } from "./notServed";

function embed(text: string) {
  const script = document.createElement("script");
  script.type = "application/json";
  script.id = NOT_SERVED_ELEMENT_ID;
  script.textContent = text;
  document.head.append(script);
}

describe("readNotServed", () => {
  afterEach(() => document.getElementById(NOT_SERVED_ELEMENT_ID)?.remove());

  it("is null on an ordinary page", () => {
    expect(readNotServed()).toBeNull();
  });

  it("reads the facts the server embedded", () => {
    embed(
      JSON.stringify({
        name: "Rosa and Maya",
        open_href: "/?project=x",
        home_href: "/?home=1",
      }),
    );
    expect(readNotServed()).toEqual({
      name: "Rosa and Maya",
      openHref: "/?project=x",
      homeHref: "/?home=1",
    });
  });

  it("ignores a malformed element", () => {
    embed("{not json");
    expect(readNotServed()).toBeNull();
    document.getElementById(NOT_SERVED_ELEMENT_ID)?.remove();
    embed(JSON.stringify({ name: 3 }));
    expect(readNotServed()).toBeNull();
  });
});
