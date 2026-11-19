import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readBootName } from "./bootName";

const CASES = (
  JSON.parse(
    readFileSync(
      join(__dirname, "../stage/frame/__fixtures__/review-boot-header.json"),
      "utf8",
    ),
  ) as { cases: { label: string; name: string; markup: string }[] }
).cases;

const rootWith = (html: string) => {
  const root = document.createElement("div");
  root.id = "root";
  root.innerHTML = html;
  return root;
};

describe("readBootName", () => {
  it.each(CASES)(
    "gives back the name exactly as the server wrote it: $label",
    ({ name, markup }) => {
      expect(readBootName(rootWith(markup))).toBe(name);
    },
  );

  it("keeps whitespace at the name's edges, so React's first commit draws the server's characters", () => {
    const root = rootWith(
      '<main class="guest-loading"><h1 class="sr-only">  Pilot episode  </h1></main>',
    );
    expect(readBootName(root)).toBe("  Pilot episode  ");
  });

  it("is null for an empty root, which is every page the server does not name", () => {
    expect(readBootName(rootWith(""))).toBeNull();
  });

  it("is null for a null root", () => {
    expect(readBootName(null)).toBeNull();
  });

  it("is null for the recording room's loading markup", () => {
    const root = rootWith(
      '<main class="guest-loading" aria-busy="true"><p role="status" class="sr-only">Joining the room…</p></main>',
    );
    expect(readBootName(root)).toBeNull();
  });

  it("is null for a root that holds something else, or a heading that is not the loading screen's", () => {
    expect(
      readBootName(rootWith("<main><h1>Pilot episode</h1></main>")),
    ).toBeNull();
    expect(
      readBootName(
        rootWith(
          '<section><main class="guest-loading"><h1 class="sr-only">Pilot</h1></main></section>',
        ),
      ),
    ).toBeNull();
    expect(
      readBootName(
        rootWith(
          '<main class="guest-loading"><div><h1 class="sr-only">Pilot</h1></div></main>',
        ),
      ),
    ).toBeNull();
  });

  it("is null for a heading with no name in it", () => {
    expect(
      readBootName(
        rootWith(
          '<main class="guest-loading"><h1 class="sr-only"></h1></main>',
        ),
      ),
    ).toBeNull();
    expect(
      readBootName(
        rootWith(
          '<main class="guest-loading"><h1 class="sr-only"> \n\t</h1></main>',
        ),
      ),
    ).toBeNull();
  });
});
