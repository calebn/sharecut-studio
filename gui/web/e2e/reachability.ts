import type { Page } from "@playwright/test";

/** The WCAG 2.5.5 floor this app holds every touch target to (`--touch-min`, 2.75rem at 16px). */
export const TOUCH_FLOOR_PX = 44;

export type Reach = {
  failure: "small" | "outside-viewport" | "covered" | "overflows-container";
  control: string;
  layout: { width: number; height: number };
  rect: { left: number; top: number; right: number; bottom: number };
  coveredBy?: string;
};

export type ReachScan = {
  /** Where to look: every match is a root. The whole page when omitted. */
  scope?: string;
  /** Regions the scan leaves out (a sheet, or panels another scan covers). */
  skip?: readonly string[];
  /**
   * Canvas targets that meet the floor through the dense-target pattern
   * (docs/communication-philosophy.md, mobile checklist): they are not
   * measured, because their hit area and equivalent controls are.
   */
  dense?: readonly string[];
  /** Exact element matches exempt from size only; all geometry checks still run. */
  sizeExempt?: readonly string[];
};

const INTERACTIVE = [
  "button",
  "a[href]",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  '[role="button"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="slider"]',
  '[role="link"]',
].join(",");

/**
 * Every interactive control a person on a touch screen could not use: smaller
 * than the touch floor, outside the visual viewport once scrolled to, spilling
 * out of the region that holds it, or covered by something that is not the
 * control.
 *
 * Size is the layout box (`offsetWidth`/`offsetHeight`), so a transform
 * mid-transition cannot shrink it (#1418). A checkbox or radio is measured by
 * its label, which is what a finger hits. Position and the cover test run after
 * the control is scrolled to the middle of its scroller.
 */
export async function reachFailures(
  page: Page,
  scan: ReachScan = {},
): Promise<Reach[]> {
  return page.evaluate(
    ({ selector, floor, scope, skip, dense, sizeExempt }) => {
      const describe = (el: Element) => {
        const name = (el.getAttribute("aria-label") ?? el.textContent ?? "")
          .trim()
          .slice(0, 40);
        const cls = (el.getAttribute("class") ?? "").split(/\s+/)[0] ?? "";
        return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""} "${name}"`;
      };
      const hidden = (el: Element) => {
        if (el.closest("[inert],[hidden],[aria-hidden='true']")) return true;
        // A closed <details> hides everything in it except its own summary.
        for (
          let d = el.parentElement?.closest("details");
          d;
          d = d.parentElement?.closest("details")
        ) {
          if (!d.open && !(el.parentElement === d && el.tagName === "SUMMARY"))
            return true;
        }
        for (let n: Element | null = el; n; n = n.parentElement) {
          const s = getComputedStyle(n);
          if (s.display === "none" || s.visibility === "hidden") return true;
        }
        return false;
      };
      const matches = (el: Element, list: readonly string[]) =>
        list.length > 0 && el.closest(list.join(",")) !== null;
      const vv = window.visualViewport;
      const viewW = vv?.width ?? window.innerWidth;
      const viewH = vv?.height ?? window.innerHeight;
      const roots = scope
        ? [...document.querySelectorAll<HTMLElement>(scope)]
        : [document.body];
      const controls = new Set<HTMLElement>();
      for (const root of roots) {
        for (const el of root.querySelectorAll<HTMLElement>(selector)) {
          controls.add(el);
        }
      }
      const out: Reach[] = [];
      for (const el of controls) {
        if (hidden(el) || matches(el, skip) || matches(el, dense)) continue;
        const label =
          el instanceof HTMLInputElement &&
          (el.type === "checkbox" || el.type === "radio")
            ? el.labels?.[0]
            : undefined;
        const target = label ?? el;
        const layout = {
          width: target.offsetWidth,
          height: target.offsetHeight,
        };
        if (!layout.width || !layout.height) continue;
        target.scrollIntoView({ block: "center", inline: "center" });
        const box = target.getBoundingClientRect();
        const rect = {
          left: box.left,
          top: box.top,
          right: box.right,
          bottom: box.bottom,
        };
        const base = { control: describe(el), layout, rect };
        if (
          !sizeExempt.some((selector) => el.matches(selector)) &&
          (layout.width < floor - 0.5 || layout.height < floor - 0.5)
        ) {
          out.push({ failure: "small", ...base });
        }
        const slop = 1;
        if (
          rect.left < -slop ||
          rect.top < -slop ||
          rect.right > viewW + slop ||
          rect.bottom > viewH + slop
        ) {
          out.push({ failure: "outside-viewport", ...base });
          continue;
        }
        const root = roots.find((r) => r.contains(el));
        const held = root?.getBoundingClientRect();
        if (scope && held && rect.right > held.right + slop) {
          out.push({ failure: "overflows-container", ...base });
        }
        const x = (rect.left + rect.right) / 2;
        const y = (rect.top + rect.bottom) / 2;
        const top = document.elementFromPoint(x, y);
        if (top && top !== el && !el.contains(top) && !top.contains(el)) {
          const labelled = (el as HTMLInputElement).labels?.[0];
          if (!(labelled && (labelled === top || labelled.contains(top)))) {
            const tr = top.getBoundingClientRect();
            const pl = el.closest(".sys-player");
            const pc = pl ? getComputedStyle(pl) : null;
            const er = el.getBoundingClientRect();
            out.push({
              failure: "covered",
              ...base,
              coveredBy:
                describe(top) +
                ` top@${[tr.left, tr.top, tr.width, tr.height].map(Math.round)} el@${[er.left, er.top, er.width, er.height].map(Math.round)} pt@${Math.round(x)},${Math.round(y)} vw=${innerWidth} player=${pl ? pl.getBoundingClientRect().width : "-"} cols=${pc?.gridTemplateColumns} topChain=${[
                  ...(function* () {
                    let n: Element | null = top;
                    while (n && n !== document.body) {
                      yield (n.className?.toString?.() || n.tagName).slice(
                        0,
                        30,
                      );
                      n = n.parentElement;
                    }
                  })(),
                ]
                  .slice(0, 6)
                  .join(">")}`,
            });
          }
        }
      }
      return out;
    },
    {
      selector: INTERACTIVE,
      floor: TOUCH_FLOOR_PX,
      scope: scan.scope ?? "",
      skip: [...(scan.skip ?? [])],
      dense: [...(scan.dense ?? [])],
      sizeExempt: [...(scan.sizeExempt ?? [])],
    },
  );
}

/** One line per failure, for an assertion message a person can act on. */
export function describeReach(failures: readonly Reach[]): string {
  return failures
    .map(
      (f) =>
        `${f.failure}: ${f.control} ${f.layout.width}x${f.layout.height}` +
        (f.coveredBy ? ` under ${f.coveredBy}` : ""),
    )
    .join("\n");
}
