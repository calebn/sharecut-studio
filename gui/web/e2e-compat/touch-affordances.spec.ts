import { test } from "@playwright/test";
import {
  exerciseClipInspectorAffordances,
  exerciseInviteAffordances,
} from "../e2e/touchAffordances";

test.use({ hasTouch: true });

const viewport = { width: 390, height: 844 } as const;

test("Invite touch affordances work in the compatibility browser", async ({
  page,
  browserName,
}) => {
  await exerciseInviteAffordances({
    page,
    viewport,
    theme: "dark",
    reducedMotion: true,
    owner: { suite: "compat", engine: browserName },
  });
});

test("clip Inspector touch affordances work in the compatibility browser", async ({
  page,
  browserName,
}) => {
  await exerciseClipInspectorAffordances({
    page,
    viewport,
    theme: "dark",
    reducedMotion: true,
    owner: { suite: "compat", engine: browserName },
  });
});
