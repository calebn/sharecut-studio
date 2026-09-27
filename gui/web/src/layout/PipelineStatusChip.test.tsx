import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { pipelineJobSnapshot } from "../test/fixtures";
import { PipelineStatusChip } from "./PipelineStatusChip";

describe("PipelineStatusChip", () => {
  it("shows a determinate running job and opens its panel", async () => {
    const onClick = vi.fn();
    const { container } = render(
      <footer className="status-bar">
        <PipelineStatusChip
          job={pipelineJobSnapshot()}
          runningCount={2}
          onClick={onClick}
        />
      </footer>,
    );
    const chip = screen.getByRole("button", {
      name: /Pipeline: running · Preparing mix preview · 1\/3 steps/,
    });
    expect(chip).toHaveAttribute("aria-busy", "true");
    expect(chip).toHaveTextContent("2 activities");
    expect(chip.querySelector(".pipeline-pulse")).toBeTruthy();
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
  });

  it("renders a completed guest activity as noninteractive chrome", async () => {
    const { container } = render(
      <footer className="status-bar">
        <PipelineStatusChip
          job={pipelineJobSnapshot({
            kind: "agent",
            status: "ok",
            message: "Transcript ready",
            current: null,
            total: null,
          })}
        />
      </footer>,
    );
    expect(screen.queryByRole("button")).toBeNull();
    const chip = screen
      .getByText(/Activity: ok · Transcript ready/)
      .closest(".status-pipeline");
    expect(chip).toHaveClass("status-pipeline--static");
    expect(chip).not.toHaveAttribute("aria-busy");
    expect(chip?.querySelector(".pipeline-pulse")).toBeNull();
    await expectNoA11yViolations(container);
  });

  it("labels failed jobs distinctly", () => {
    render(
      <PipelineStatusChip
        job={pipelineJobSnapshot({
          status: "error",
          message: "Mix preview failed",
        })}
      />,
    );
    expect(
      screen.getByText(/Pipeline: failed · Mix preview failed/),
    ).toBeTruthy();
  });

  it("shows stall copy against a supplied clock", async () => {
    const onClick = vi.fn();
    const { container } = render(
      <PipelineStatusChip
        job={pipelineJobSnapshot({ last_progress_at: 1000 })}
        nowSec={1042}
        onClick={onClick}
      />,
    );
    const chip = screen.getByRole("button", { name: /Pipeline: running/ });
    expect(chip).toHaveTextContent("· last update 42s ago");
    await expectNoA11yViolations(container);
  });
});
