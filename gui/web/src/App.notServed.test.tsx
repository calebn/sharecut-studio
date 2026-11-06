import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App";
import { NOT_SERVED_ELEMENT_ID } from "./utils/notServed";

describe("App on a project this server does not serve", () => {
  afterEach(() => document.getElementById(NOT_SERVED_ELEMENT_ID)?.remove());

  it("draws the Status cover from the facts the server embedded, with no API calls", () => {
    const script = document.createElement("script");
    script.type = "application/json";
    script.id = NOT_SERVED_ELEMENT_ID;
    script.textContent = JSON.stringify({
      name: "Rosa and Maya",
      open_href: "/?project=x",
      home_href: "/?home=1",
    });
    document.head.append(script);
    render(<App />);
    expect(
      screen.getByRole("heading", {
        name: "This episode isn't open on this computer",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open Rosa and Maya" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "All projects" }),
    ).toBeInTheDocument();
  });
});
