import { LinkRow, type LinkRowProps } from "../../system/LinkRow";
import { DeliverSection } from "./DeliverSection";

type Props = Omit<LinkRowProps, "access" | "onAccess" | "note"> & {
  /** The exported version the link is pinned to: "Rough cut". */
  pinnedTo: string;
};

/** The listen link for the final: a Viewer link pinned to the exported version. */
export function ListenLink({ pinnedTo, ...row }: Props) {
  return (
    <DeliverSection title="Listen link">
      <LinkRow access="viewer" note={`Pinned to ${pinnedTo}`} {...row} />
    </DeliverSection>
  );
}
