import type {
  PipelineConfigResponse,
  PipelineJobSnapshot,
} from "../../types/pipeline";
import { getByPath, setByPath } from "../../utils/configPath";
import type { AdvancedGroup, AdvancedStep } from "./AdvancedSteps";
import { SOUND_SCAN_COST, SOUND_SCAN_PATH, SOUND_SCAN_STEP } from "./soundScan";

/**
 * The four pipeline steps that have a row in the Prepare design, with the one
 * or two settings the design names for each. Every other step keeps running
 * with its saved settings and has no control here.
 */
type ParamDef =
  | {
      kind: "scrub";
      id: string;
      path: string;
      label: string;
      help: string;
      min: number;
      max: number;
      step: number;
      unit: readonly [string, string];
    }
  | {
      kind: "language";
      id: string;
      path: string;
      label: string;
      help: string;
    };

type StepDef = {
  id: string;
  name: string;
  optional: boolean;
  params: readonly ParamDef[];
};

type GroupDef = { id: string; title: string; steps: readonly StepDef[] };

const LANGUAGE_PATH = "transcribe.language";
const AUTO_LANGUAGE = "auto";
const TIGHTEN_ENABLED_PATH = "tighten.enabled";
/** A switch on one of these also turns tighten on or off in the saved settings. */
const TIGHTEN_STEPS = new Set([
  "analyze_fillers_pauses",
  "tighten_from_transcript",
]);

const LANGUAGES = [
  { value: AUTO_LANGUAGE, label: "Detect automatically" },
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "nl", label: "Dutch" },
] as const;

const SECONDS = ["second", "seconds"] as const;

const ADVANCED_DEFS: readonly GroupDef[] = [
  {
    id: "transcribe",
    title: "Transcribe",
    steps: [
      {
        id: "transcribe_tracks",
        name: "Transcribe each track",
        optional: false,
        params: [
          {
            kind: "language",
            id: "language",
            path: LANGUAGE_PATH,
            label: "Language",
            help: "What the speakers talk in. Detect automatically works for most shows.",
          },
        ],
      },
    ],
  },
  {
    id: "line-up",
    title: "Line up tracks",
    steps: [
      {
        id: "align_tracks",
        name: "Line up tracks",
        optional: false,
        params: [
          {
            kind: "scrub",
            id: "max-move",
            path: "align.large_move_sec",
            label: "Largest move",
            help: "The most a track may move to line up before it needs a look.",
            min: 0.5,
            max: 30,
            step: 0.5,
            unit: SECONDS,
          },
        ],
      },
    ],
  },
  {
    id: "clean",
    title: "Clean and level",
    steps: [
      {
        id: "fill_gate_holes",
        name: "Fill gaps from the recorder's noise gate",
        optional: true,
        params: [
          {
            kind: "scrub",
            id: "fade",
            path: "gate_fill.fade_ms",
            label: "Fade at the gap edges",
            help: "A short fade keeps the edges of a gap from clicking.",
            min: 0,
            max: 100,
            step: 5,
            unit: ["millisecond", "milliseconds"],
          },
        ],
      },
    ],
  },
  {
    id: "suggest",
    title: "Find suggestions",
    steps: [
      {
        id: "analyze_fillers_pauses",
        name: "Find fillers and pauses",
        optional: true,
        params: [
          {
            kind: "scrub",
            id: "longest-pause",
            path: "tighten.max_pause_sec",
            label: "Flag pauses longer than",
            help: "Longer pauses become suggestions. Shorter ones are left alone.",
            min: 0.2,
            max: 5,
            step: 0.1,
            unit: SECONDS,
          },
        ],
      },
    ],
  },
  {
    id: "sounds",
    title: "Listen for sounds",
    steps: [
      {
        id: SOUND_SCAN_STEP,
        name: "Apply sound actions",
        optional: true,
        params: [],
      },
    ],
  },
];

const SOUND_SCAN_HELP =
  "Applies suggested sound actions during processing. New projects start with it off unless you change that below.";
const SOUND_SCAN_START_NOTE =
  "Saved in this browser for new episodes. This episode's switch resets to its default when ShareCut restarts.";

export function paramPath(stepId: string, paramId: string): string | null {
  for (const group of ADVANCED_DEFS) {
    for (const step of group.steps) {
      if (step.id !== stepId) continue;
      return step.params.find((p) => p.id === paramId)?.path ?? null;
    }
  }
  return null;
}

function languageValue(raw: unknown): string {
  return typeof raw === "string" && raw ? raw : AUTO_LANGUAGE;
}

function stepResult(
  job: PipelineJobSnapshot | null,
  stepId: string,
): string | undefined {
  const done = job?.steps.find((s) => s.name === stepId && s.summary);
  return done?.summary ?? undefined;
}

/** Settings that belong to the person, read where they are saved. */
export type AdvancedPersonal = { soundScanStart: boolean };

/** The sound-action cost is conditional on needing analysis. */
export function soundScanResult(
  enabled: boolean,
  ran: string | undefined,
): string {
  if (enabled && ran) return ran;
  const cost = `Can take ${SOUND_SCAN_COST} when analysis is needed.`;
  return enabled ? cost : `Off. ${cost}`;
}

export function advancedGroups(
  cfg: PipelineConfigResponse,
  job: PipelineJobSnapshot | null,
  personal: AdvancedPersonal = { soundScanStart: false },
): AdvancedGroup[] {
  return ADVANCED_DEFS.map((group) => ({
    id: group.id,
    title: group.title,
    steps: group.steps.map(
      (step): AdvancedStep => ({
        id: step.id,
        name: step.name,
        result:
          step.id === SOUND_SCAN_STEP
            ? soundScanResult(
                cfg.enabled_steps.includes(step.id) &&
                  getByPath(cfg.config, SOUND_SCAN_PATH) === true,
                stepResult(job, step.id),
              )
            : stepResult(job, step.id),
        ...(step.id === SOUND_SCAN_STEP
          ? {
              help: SOUND_SCAN_HELP,
              personal: {
                label: "New projects start with this",
                on: personal.soundScanStart,
                note: SOUND_SCAN_START_NOTE,
              },
            }
          : {}),
        optional: step.optional,
        enabled:
          cfg.enabled_steps.includes(step.id) &&
          (step.id !== SOUND_SCAN_STEP ||
            getByPath(cfg.config, SOUND_SCAN_PATH) === true),
        params: step.params.map((param) => {
          const value = getByPath(cfg.config, param.path);
          const fallback = getByPath(cfg.defaults, param.path);
          if (param.kind === "language") {
            return {
              kind: "language",
              id: param.id,
              label: param.label,
              help: param.help,
              value: languageValue(value),
              defaultValue: languageValue(fallback),
              options: LANGUAGES,
            };
          }
          const defaultValue =
            typeof fallback === "number" ? fallback : param.min;
          return {
            kind: "scrub",
            id: param.id,
            label: param.label,
            help: param.help,
            value: typeof value === "number" ? value : defaultValue,
            defaultValue,
            min: param.min,
            max: param.max,
            step: param.step,
            unit: param.unit,
          };
        }),
      }),
    ),
  }));
}

/** The settings with one step setting changed. A language of "auto" is no language. */
export function withParam(
  config: Record<string, unknown>,
  path: string,
  value: number | string,
): Record<string, unknown> {
  return setByPath(
    config,
    path,
    path === LANGUAGE_PATH && value === AUTO_LANGUAGE ? null : value,
  );
}

/** The patch for a step switch: the step list, and tighten for the steps that gate it. */
export function withStepSwitch(
  current: Pick<PipelineConfigResponse, "config" | "enabled_steps">,
  stepId: string,
  enabled: boolean,
): { enabled_steps: string[]; config?: Record<string, unknown> } {
  const set = new Set(current.enabled_steps);
  if (enabled) set.add(stepId);
  else set.delete(stepId);
  const patch: { enabled_steps: string[]; config?: Record<string, unknown> } = {
    enabled_steps: [...set],
  };
  if (stepId === SOUND_SCAN_STEP) {
    patch.config = setByPath(current.config, SOUND_SCAN_PATH, enabled);
  }
  if (TIGHTEN_STEPS.has(stepId)) {
    patch.config = setByPath(
      current.config,
      TIGHTEN_ENABLED_PATH,
      [...TIGHTEN_STEPS].some((id) => set.has(id)),
    );
  }
  return patch;
}
