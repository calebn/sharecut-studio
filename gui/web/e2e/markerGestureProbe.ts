import fs from "node:fs";
import path from "node:path";
import type { Page, TestInfo } from "@playwright/test";

type Probe = {
  events: unknown[];
  dropped: number;
  mark: (label: string) => void;
  stop: () => void;
};
type ProbeWindow = Window & { markerGestureProbe?: Probe };

export async function markerGestureProbe(page: Page) {
  await page.evaluate(() => {
    const host = window as ProbeWindow;
    host.markerGestureProbe?.stop();
    const controller = new AbortController();
    const events: unknown[] = [];
    const identity = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null;
      const marker = target.closest(".sys-marker");
      return {
        tag: target.tagName,
        class: target.getAttribute("class"),
        label: target.getAttribute("aria-label"),
        hitId: target.getAttribute("data-hit-id"),
        hitKind: target.getAttribute("data-hit-kind"),
        edge: target.getAttribute("data-edge"),
        dragging: target.getAttribute("data-dragging"),
        markerKind: marker?.getAttribute("data-kind"),
        markerDragging: marker?.getAttribute("data-dragging"),
        rect: target.getBoundingClientRect().toJSON(),
      };
    };
    const state = () => ({
      activeElement: identity(document.activeElement),
      markers: [
        ...document.querySelectorAll('.sys-marker[data-kind="clip"]'),
      ].map(identity),
      edges: [...document.querySelectorAll(".sys-marker-edge")].map(identity),
      readouts: [...document.querySelectorAll(".sys-readout")].map((node) => ({
        node: identity(node),
        text: node.textContent,
      })),
    });
    const push = (entry: unknown) => {
      if (events.length < 512) events.push(entry);
      else probe.dropped++;
    };
    const probe: Probe = {
      events,
      dropped: 0,
      mark: (label) => push({ label, time: performance.now(), ...state() }),
      stop: () => controller.abort(),
    };
    host.markerGestureProbe = probe;
    for (const capture of [true, false]) {
      for (const type of [
        "pointerdown",
        "pointerup",
        "focus",
        "blur",
        "focusin",
        "focusout",
      ]) {
        document.addEventListener(
          type,
          (event) => {
            const pointer = event instanceof PointerEvent ? event : null;
            push({
              type,
              capture,
              eventPhase: event.eventPhase,
              time: performance.now(),
              trusted: event.isTrusted,
              defaultPrevented: event.defaultPrevented,
              target: identity(event.target),
              currentTarget: "document",
              relatedTarget: identity(
                event instanceof FocusEvent ? event.relatedTarget : null,
              ),
              pointerId: pointer?.pointerId,
              clientX: pointer?.clientX,
              clientY: pointer?.clientY,
              captures: pointer
                ? [
                    ...document.querySelectorAll(
                      ".sys-marker-hit, .sys-marker-edge, .sys-markers-track",
                    ),
                  ]
                    .filter((node) => node.hasPointerCapture(pointer.pointerId))
                    .map(identity)
                : [],
              ...state(),
            });
          },
          { capture, signal: controller.signal },
        );
      }
    }
    probe.mark("installed");
  });
  return {
    mark: (label: string) =>
      page.evaluate((label) => {
        (window as ProbeWindow).markerGestureProbe?.mark(label);
      }, label),
    attach: async (info: TestInfo, name: string) => {
      const receipt = await page.evaluate(() => {
        const host = window as ProbeWindow;
        const probe = host.markerGestureProbe;
        if (!probe) return null;
        probe.mark("finally");
        probe.stop();
        delete host.markerGestureProbe;
        return { limit: 512, dropped: probe.dropped, events: probe.events };
      });
      const file = path.join(
        "playwright-report",
        `issue-2964-${name.replace(/[^a-zA-Z0-9_-]/g, "-")}-retry${info.retry}.json`,
      );
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
      await info.attach(name, {
        path: file,
        contentType: "application/json",
      });
    },
  };
}
