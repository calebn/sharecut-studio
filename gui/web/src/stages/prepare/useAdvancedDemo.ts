import { useState } from "react";
import type { AdvancedGroup, AdvancedStepsProps } from "./AdvancedSteps";

type Spy = Pick<
  AdvancedStepsProps,
  | "onSelect"
  | "onBack"
  | "onToggle"
  | "onParam"
  | "onReset"
  | "onRunFromHere"
  | "onCancel"
>;

/**
 * Story-only state for the step list: the open step, switches and settings
 * change in place, and each change is also passed on to `spy`. The real stage
 * keeps this in the project.
 */
export function useAdvancedDemo(
  initial: readonly AdvancedGroup[],
  initialSelected: string | undefined,
  spy: Spy,
): Pick<AdvancedStepsProps, "groups" | "selectedId"> & Spy {
  const [groups, setGroups] = useState(initial);
  const [selectedId, setSelectedId] = useState(initialSelected);
  const edit = (
    id: string,
    update: (
      s: AdvancedGroup["steps"][number],
    ) => AdvancedGroup["steps"][number],
  ) =>
    setGroups((all) =>
      all.map((group) => ({
        ...group,
        steps: group.steps.map((step) =>
          step.id === id ? update(step) : step,
        ),
      })),
    );
  return {
    groups,
    selectedId,
    onSelect: (id) => {
      setSelectedId(id);
      spy.onSelect(id);
    },
    onBack: () => {
      setSelectedId(undefined);
      spy.onBack();
    },
    onToggle: (id, enabled) => {
      edit(id, (step) => ({ ...step, enabled }));
      spy.onToggle(id, enabled);
    },
    onParam: (id, paramId, value) => {
      edit(id, (step) => ({
        ...step,
        params: step.params.map((param) =>
          param.id === paramId ? ({ ...param, value } as typeof param) : param,
        ),
      }));
      spy.onParam(id, paramId, value);
    },
    onReset: (id, paramId) => {
      edit(id, (step) => ({
        ...step,
        params: step.params.map((param) =>
          param.id === paramId
            ? ({ ...param, value: param.defaultValue } as typeof param)
            : param,
        ),
      }));
      spy.onReset(id, paramId);
    },
    onRunFromHere: spy.onRunFromHere,
    onCancel: spy.onCancel,
  };
}
