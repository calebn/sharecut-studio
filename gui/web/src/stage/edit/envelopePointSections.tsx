import { useState } from "react";
import {
  removeEnvelopePoint,
  setEnvelopePoint,
} from "../../commands/envelopes";
import { useMountedRef } from "../../hooks/useMountedRef";
import { canEditEnvelopes } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import type { InspectorSection } from "../../system/InspectorSheet";
import { ScrubField } from "../../system/ScrubField";
import type { Selection } from "../../types/project";
import { Button } from "../../ui";
import { ENVELOPE_VALUE_MAX, sortedVolumePoints } from "../../utils/envelopes";

type Failure = {
  pointId: string;
  message: string;
  conflict: boolean;
  collisionId: string | null;
};

const note = (text: string) => <p className="sys-inspector-note">{text}</p>;

/**
 * The Inspector's content for a volume envelope point: Time and Level as
 * Scrub fields, each gesture one save and one undo step, and Remove. A failed
 * save stays in the sheet as an alert; a conflict offers the reload.
 */
export function useEnvelopePointSections(
  selection: Selection,
): readonly InspectorSection[] | null {
  const { project, projectPath, guestMode, shareCapabilities, showLevels } =
    useDaw((s) => ({
      project: s.project,
      projectPath: s.projectPath,
      guestMode: s.guestMode,
      shareCapabilities: s.shareCapabilities,
      showLevels: s.layers.showLevels,
    }));
  const selectFromInspector = useDaw((s) => s.selectFromInspector);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const mounted = useMountedRef();
  if (selection?.kind !== "envelopePoint") return null;
  const { trackId, pointId } = selection;
  const points = sortedVolumePoints(project?.envelopes, trackId);
  const point = points.find((candidate) => candidate.id === pointId);
  if (!point) {
    return [
      {
        id: "gone",
        rows: [
          {
            id: "gone",
            control: note(
              "This point is no longer available. Select another point or add one.",
            ),
          },
        ],
      },
    ];
  }
  const editable = canEditEnvelopes(projectPath, guestMode, shareCapabilities);
  const locked = !editable || !showLevels || busy;
  const shown = failure?.pointId === pointId ? failure : null;
  const run = async (
    write: ReturnType<typeof setEnvelopePoint>,
  ): Promise<void> => {
    setBusy(true);
    setFailure(null);
    const result = await write;
    if (!mounted.current) return;
    setBusy(false);
    if (result.status === "disabled")
      setFailure({
        pointId,
        message: result.reason,
        conflict: result.conflict === true,
        collisionId: result.collisionId ?? null,
      });
  };
  const only = points.length === 1;
  return [
    {
      id: "point",
      rows: [
        {
          id: "time",
          label: "Time",
          control: (
            <ScrubField
              label="Time"
              value={point.time}
              unit="s"
              step={0.01}
              decimals={3}
              min={0}
              max={project?.timeline_duration_sec}
              readOnly={locked}
              onCommit={(time) =>
                void run(setEnvelopePoint(trackId, pointId, { time }))
              }
            />
          ),
        },
        {
          id: "level",
          label: "Level",
          control: (
            <ScrubField
              label="Level"
              variant="level"
              value={point.value}
              unit="×"
              step={0.01}
              min={0}
              max={ENVELOPE_VALUE_MAX}
              defaultValue={1}
              readOnly={locked}
              onCommit={(value) =>
                void run(setEnvelopePoint(trackId, pointId, { value }))
              }
            />
          ),
        },
        {
          id: "help",
          control: note(
            "Level multiplies this track’s volume: 1.00× is unchanged, 0 is silent, and 1.50× is the maximum.",
          ),
        },
        ...(!editable
          ? [
              {
                id: "view",
                control: note(
                  "This link can view, but not edit, the volume envelope.",
                ),
              },
            ]
          : !showLevels
            ? [
                {
                  id: "hidden",
                  control: (
                    <p className="sys-inspector-note" role="status">
                      The volume envelope is hidden. Show it before changing
                      points.
                    </p>
                  ),
                },
              ]
            : []),
        ...(shown
          ? [
              {
                id: "error",
                control: (
                  <div>
                    <p className="sys-inspector-note" role="alert">
                      {shown.message}
                    </p>
                    {shown.collisionId ? (
                      <Button
                        onClick={() =>
                          selectFromInspector({
                            kind: "envelopePoint",
                            trackId,
                            pointId: shown.collisionId!,
                          })
                        }
                      >
                        Select the point there
                      </Button>
                    ) : null}
                    {shown.conflict ? (
                      <Button onClick={() => setFailure(null)}>
                        Reload points
                      </Button>
                    ) : null}
                  </div>
                ),
              },
            ]
          : []),
      ],
    },
    ...(editable
      ? [
          {
            id: "remove",
            rows: [
              {
                id: "remove",
                control: (
                  <>
                    {only
                      ? note(
                          "Removing this envelope returns automation to 1.00×. Track volume and effects stay unchanged.",
                        )
                      : null}
                    <Button
                      variant="danger"
                      disabledReason={
                        showLevels
                          ? undefined
                          : "Show the volume envelope before changing points."
                      }
                      onClick={() =>
                        void run(removeEnvelopePoint(trackId, pointId))
                      }
                    >
                      {only ? "Remove volume envelope" : "Remove point"}
                    </Button>
                  </>
                ),
              },
            ],
          },
        ]
      : []),
  ];
}

/** The same content in the peek strip's drawer, until the strip goes. */
export function EnvelopePointBody() {
  const sections = useEnvelopePointSections(useDaw((s) => s.selection));
  return (
    <div className="sys-inspector-rows">
      {sections?.flatMap((section) =>
        section.rows.map((row) => (
          <div
            key={row.id}
            className="sys-inspector-row"
            data-unlabelled={row.label ? undefined : ""}
          >
            {row.label ? (
              <span className="sys-inspector-label">{row.label}</span>
            ) : null}
            <div className="sys-inspector-slot">{row.control}</div>
          </div>
        )),
      )}
    </div>
  );
}
