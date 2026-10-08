import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { assessEditingTrial } from "./editingTaskReport";
import { editingTaskRegistry, runEditingTask } from "./editingTasks";

test("current-main editing task saved-state proof", async ({
  page,
  context,
}, info) => {
  test.skip(
    !process.env.EDITING_TASK_OUT,
    "Dedicated editing-task runner only",
  );
  test.setTimeout(120_000);
  const task = editingTaskRegistry.find(
    (row) => row.id === process.env.EDITING_TASK,
  );
  if (!task || !process.env.EDITING_ROUTE || !process.env.EDITING_TASK_OUT)
    throw new Error("Missing editing task selection");
  const trial = await runEditingTask(
    page,
    await context.newCDPSession(page),
    info,
    task,
    process.env.EDITING_ROUTE,
    process.env.EDITING_TASK_OUT,
    process.env.EDITING_MODE === "baseline"
      ? "baseline"
      : process.env.EDITING_MODE === "diagnostic"
        ? "diagnostic"
        : "validity-only",
  );
  const assessment = assessEditingTrial(task, trial);
  await info.attach("editing-trial", {
    body: fs.readFileSync(`${process.env.EDITING_TASK_OUT}/trial.json`),
    contentType: "application/json",
  });
  expect(assessment, JSON.stringify(assessment)).toMatchObject({
    status: "pass",
    completedWork: 1,
  });
});
