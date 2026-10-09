import {
  type CDPSession,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import { niceTimeStep } from "../src/utils/time";
import type {
  CancellationProbe,
  TaskDefinition,
  TaskRoute,
} from "./editingTaskReport";

type InputContext = Readonly<{
  active: Page;
  session: CDPSession;
  task: TaskDefinition;
  route: Extract<
    TaskRoute,
    { input: "pointer" | "keyboard" | "numeric" | "cdp-touch" }
  >;
  intent: { kind: "action" } | { kind: "cancel"; probe: CancellationProbe };
}>;
type InputRecorder = Readonly<{
  act(
    verb: string,
    label: string,
    action: () => Promise<unknown>,
  ): Promise<unknown>;
  captureUi(page: Page, stage: string, screenshot?: boolean): Promise<void>;
  waitForActionResponses(count: number): Promise<void>;
}>;

export async function navigateEditingTimeline(
  active: Page,
  activate: (control: Locator, label: string) => Promise<unknown>,
) {
  if (!(await active.locator(".timeline-scroll").isVisible()))
    await activate(
      active
        .getByRole("navigation", { name: "Primary" })
        .getByRole("button", { name: "Timeline", exact: true }),
      "Primary Timeline",
    );
  await active.locator(".timeline-scroll").waitFor({ state: "visible" });
}
export async function tabToEditingControl(
  control: Locator,
  press: (key: string) => Promise<unknown>,
) {
  for (
    let index = 0;
    index < 80 &&
    !(await control.evaluate((element) => document.activeElement === element));
    index++
  )
    await press("Tab");
  if (
    !(await control.evaluate((element) => document.activeElement === element))
  )
    throw new Error("Track header not reached by Tab");
  await press("Enter");
}

export async function performEditingInput(
  context: InputContext,
  recorder: InputRecorder,
): Promise<void> {
  const { active, session, task, route, intent } = context;
  const cancel = intent.kind === "cancel";
  const { act, captureUi, waitForActionResponses } = recorder;
  const routeId = route.id;
  const click = (control: Locator, label: string) =>
    act("click", label, () => control.click());
  const fill = (control: Locator, value: string, label: string) =>
    act("fill", label, () => control.fill(value));
  const key = (active: Page, value: string) =>
    act("key", value, () => active.keyboard.press(value));
  const focus = (control: Locator, label: string) =>
    act("focus", label, () => control.focus());
  const drag = async (
    active: Page,
    control: Locator,
    dx: number,
    dy: number,
    cancel: boolean,
  ) => {
    const box = await control.boundingBox();
    if (!box) throw new Error("Drag control has no geometry");
    await act(
      "drag",
      `${task.id} ${cancel ? "cancel" : "commit"}`,
      async () => {
        const x = box.x + box.width / 2,
          y = box.y + box.height / 2;
        await active.mouse.move(x, y);
        await active.mouse.down();
        await active.mouse.move(x + dx, y + dy, { steps: 10 });
        await captureUi(active, "intermediate-drag");
        if (cancel) await active.keyboard.press("Escape");
        await active.mouse.up();
      },
    );
  };
  const openTrack = async (active: Page, label: string) => {
    const control = active.getByRole("button", {
      name: `Open track details, ${label}`,
      exact: true,
    });
    if (routeId.endsWith("-tab-header")) {
      await tabToEditingControl(control, (value) => key(active, value));
    } else {
      const [button, title] = await Promise.all([
        control.boundingBox(),
        control.locator("xpath=..").locator(".track-title-text").boundingBox(),
      ]);
      if (
        !button ||
        !title ||
        !Object.values(button).every(Number.isFinite) ||
        !Object.values(title).every(Number.isFinite) ||
        button.width <= 0 ||
        button.height <= 0 ||
        title.width <= 0 ||
        title.height <= 0
      )
        throw new Error("Track header title has no geometry");
      await act("click", `${label} details`, () =>
        control.click({
          position: {
            x: title.x + title.width / 2 - button.x,
            y: title.y + title.height / 2 - button.y,
          },
        }),
      );
    }
  };
  const first = active.locator('[data-clip-id="first-copy"]');
  const firstBox = await first.boundingBox();
  const scale = firstBox ? firstBox.width / 5 : 0;
  if (task.id === "seek") {
    const ruler = active.getByRole("slider", {
      name: "Timeline position",
      exact: true,
    });
    if (routeId === "ruler-pointer")
      await act("click", "ruler at 5 seconds", () =>
        ruler.click({ position: { x: 5 * scale, y: 10 } }),
      );
    else {
      await focus(ruler, "ruler");
      await key(active, "Home");
      const step = niceTimeStep(scale);
      if (Math.abs(5 / step - Math.round(5 / step)) > 1e-9)
        throw new Error(`Frozen ruler step ${step} cannot reach literal5`);
      for (let index = 0; index < Math.round(5 / step); index++)
        await key(active, "ArrowRight");
    }
    return;
  }
  if (task.id === "range-cut") {
    if (routeId === "range-form") {
      await click(
        active.getByRole("button", { name: "Menu", exact: true }),
        "transport Menu",
      );
      await click(
        active.getByRole("menuitem", { name: "Select a range", exact: true }),
        "Select a range",
      );
      const range = active.getByRole("region", { name: "Range actions" });
      await fill(
        range.getByRole("spinbutton", { name: "In", exact: true }),
        "11",
        "range In",
      );
      await fill(
        range.getByRole("spinbutton", { name: "Out", exact: true }),
        "12",
        "range Out",
      );
      const lane = range.getByRole("checkbox", {
        name: "reference",
        exact: true,
      });
      if (!(await lane.isChecked()))
        await act("check", "reference range lane", () => lane.check());
      await click(
        range.getByRole("button", { name: "Select range", exact: true }),
        "Select range",
      );
    } else {
      await click(
        active.getByRole("button", { name: "Menu", exact: true }),
        "transport Menu",
      );
      await click(
        active.getByRole("menuitem", { name: "Select a range", exact: true }),
        "arm range",
      );
      const box = await active
        .locator('[data-clip-id="second-copy"]')
        .boundingBox();
      if (!box) throw new Error("Range body has no geometry");
      await act("drag", "range 11 through 12", async () => {
        await active.mouse.move(box.x + scale, box.y + box.height / 2);
        await active.mouse.down();
        await active.mouse.move(box.x + 2 * scale, box.y + box.height / 2, {
          steps: 10,
        });
        if (cancel) await active.keyboard.press("Escape");
        await active.mouse.up();
      });
    }
    const range = active.getByRole("region", { name: "Range actions" });
    if (cancel) {
      if (routeId === "range-form")
        await click(
          range.getByRole("button", { name: "Clear range", exact: true }),
          "Clear range",
        );
    } else
      await click(
        range.getByRole("button", { name: "Cut", exact: true }),
        "Cut selected range",
      );
    return;
  }
  if (task.id === "trim" || task.id === "fade") {
    const fade = task.id === "fade";
    await click(first.locator(".clip-hit"), "select first-copy");
    const handle = first.locator(fade ? ".fade-corner.in" : ".trim-handle.in");
    if (routeId === "handle-pointer" || routeId === "corner-pointer") {
      if (cancel) {
        for (
          let index = 0;
          index < 40 &&
          !(await handle.evaluate(
            (element) => document.activeElement === element,
          ));
          index++
        )
          await key(active, "Tab");
        await expect(handle).toBeFocused();
        await expect(handle).toBeVisible();
        await captureUi(active, "cancel-handle-tab-focus");
      }
      await drag(active, handle, scale * (fade ? 0.04 : 0.3), 0, cancel);
    } else if (routeId === "handle-keyboard") {
      await focus(handle, "trim In handle");
      await act("key-burst", "30 ArrowRight trim nudges", async () => {
        for (let index = 0; index < 30; index++)
          await active.keyboard.down("ArrowRight");
        if (cancel) await active.keyboard.press("Escape");
        await active.keyboard.up("ArrowRight");
      });
    } else {
      const slider = active.getByRole("slider", {
        name: "Fade in ms",
        exact: true,
      });
      await focus(slider, "Fade in ms");
      await act("key-burst", "40ms native fade preview", async () => {
        for (let index = 0; index < 40; index++)
          await active.keyboard.down("ArrowRight");
        if (cancel) await active.keyboard.press("Escape");
        await active.keyboard.up("ArrowRight");
        if (!cancel) await slider.blur();
      });
    }
    return;
  }
  if (task.id === "envelope") {
    if (routeId === "point-pointer") {
      const point = active.locator('circle[aria-label^="Envelope point 1 at"]');
      const svg = await point.locator("xpath=..").boundingBox();
      if (!svg) throw new Error("Envelope has no geometry");
      await drag(
        active,
        point,
        scale * 4,
        (-0.2 / 1.5) * (svg.height - 8),
        cancel,
      );
    } else {
      await openTrack(active, "reference");
      await click(
        active.getByRole("button", {
          name: "Edit volume envelope",
          exact: true,
        }),
        "Edit volume envelope",
      );
      await act("select", "Envelope point p1", () =>
        active
          .getByRole("combobox", { name: "Envelope point", exact: true })
          .selectOption("p1"),
      );
      await click(
        active.getByRole("button", { name: "Edit point", exact: true }),
        "Edit point",
      );
      await fill(
        active.getByRole("textbox", {
          name: "Time (seconds on timeline)",
          exact: true,
        }),
        "6",
        "point time",
      );
      await fill(
        active.getByRole("textbox", { name: "Level (×)", exact: true }),
        "0.8",
        "point level",
      );
      await click(
        active.getByRole("button", {
          name: cancel ? "Cancel" : "Save point",
          exact: true,
        }),
        cancel ? "Cancel point" : "Save point",
      );
    }
    return;
  }
  if (task.id === "reorder") {
    if (routeId === "move-up" || routeId === "move-up-tab-header") {
      await openTrack(active, "guest");
      await click(
        active.getByRole("button", { name: "Menu", exact: true }),
        "transport Menu for track reorder",
      );
      await click(
        active
          .getByRole("menu", { name: "Transport menu", exact: true })
          .getByRole("menuitem", { name: "Move track up", exact: true }),
        "Move track up menu item",
      );
    } else {
      const source = active.getByRole("button", {
        name: "Reorder track guest",
        exact: true,
      });
      const target = active
        .getByRole("button", {
          name: "Open track details, reference",
          exact: true,
        })
        .locator("xpath=..");
      if (cancel) {
        const box = await source.boundingBox();
        if (!box) throw new Error("Reorder handle unavailable");
        await act("drag", "cancel HTML drag", async () => {
          await active.mouse.move(
            box.x + box.width / 2,
            box.y + box.height / 2,
          );
          await active.mouse.down();
          await active.mouse.move(box.x + 5, box.y - 25, { steps: 8 });
          await active.keyboard.press("Escape");
          await active.mouse.up();
        });
      } else
        await act("drag", "guest before reference HTML drag", () =>
          source.dragTo(target, { targetPosition: { x: 10, y: 2 } }),
        );
    }
    return;
  }
  if (task.id === "mix" || task.id === "comment") {
    await click(
      active
        .getByRole("navigation", { name: "Primary" })
        .getByRole("button", { name: "More", exact: true }),
      "Primary More",
    );
    await click(
      active.getByRole("button", {
        name: task.id === "mix" ? "Mix" : "Comments",
        exact: true,
      }),
      task.id === "mix" ? "Mix" : "Comments",
    );
  }
  if (task.id === "mix") {
    const slider = active.getByRole("slider", {
      name: "Volume reference",
      exact: true,
    });
    if (routeId === "native-keyboard") {
      await focus(slider, "Volume reference");
      for (let index = 0; index < 12; index++) {
        await key(active, "ArrowLeft");
        await waitForActionResponses(index + 1);
      }
    } else {
      const box = await slider.boundingBox();
      if (!box) throw new Error("Mix slider unavailable");
      const min = Number(await slider.getAttribute("min")),
        max = Number(await slider.getAttribute("max"));
      const x = box.x + 8 + ((box.width - 16) * (-6 - min)) / (max - min),
        y = box.y + box.height / 2;
      if (cancel) {
        await act(
          "touch-cancel",
          "native Mix trusted touchCancel",
          async () => {
            await session.send("Input.dispatchTouchEvent", {
              type: "touchStart",
              touchPoints: [
                { x: box.x + (box.width * (0 - min)) / (max - min), y },
              ],
            });
            await session.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x, y }],
            });
            await captureUi(active, "intermediate-mix", false);
            await session.send("Input.dispatchTouchEvent", {
              type: "touchCancel",
              touchPoints: [],
            });
            await expect(slider).toHaveValue("0");
          },
        );
        return;
      }
      await act("drag", "Volume reference to -6dB", async () => {
        await active.mouse.move(
          box.x + (box.width * (0 - min)) / (max - min),
          y,
        );
        await active.mouse.down();
        await active.mouse.move(x, y, { steps: 10 });
        await active.mouse.up();
      });
    }
    return;
  }
  if (task.id === "comment") {
    const card = active
      .locator(".comment-card")
      .filter({ hasText: "Editing task comment" });
    if (routeId === "resolve-button")
      await click(
        card.getByRole("button", { name: "Resolve", exact: true }),
        "Resolve comment",
      );
    else {
      const swipe =
        intent.kind === "action"
          ? {
              kind: "comment-swipe" as const,
              dx: 64,
              dy: 0,
              end: "touchEnd" as const,
            }
          : intent.probe.input;
      if (swipe.kind !== "comment-swipe")
        throw new Error(
          "Comment cancellation requires its declared swipe recipe",
        );
      const box = await card.locator(".comment-card-main").boundingBox();
      if (!box) throw new Error("Comment unavailable");
      const x = box.x + box.width * 0.7,
        y = box.y + box.height / 2;
      await act(
        "touch-swipe",
        intent.kind === "cancel"
          ? `${intent.probe.id} comment cancellation`
          : "trusted64px comment swipe",
        async () => {
          await session.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [{ x, y }],
          });
          await session.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [
              {
                x: x - swipe.dx,
                y: y + swipe.dy,
              },
            ],
          });
          await captureUi(active, "intermediate-swipe", false);
          await session.send("Input.dispatchTouchEvent", {
            type: swipe.end,
            touchPoints: [],
          });
        },
      );
    }
  }
}
