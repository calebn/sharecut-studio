import { LinkRow, type LinkRowProps } from "../../system/LinkRow";
import { DeliverSection } from "./DeliverSection";

type Props = Omit<LinkRowProps, "access" | "note"> & {
  /** The exported version the link is pinned to: "Rough cut". */
  pinnedTo: string;
};

export function ListenLink({ pinnedTo, ...row }: Props) {
  return (
    <DeliverSection title="Listen link">
      <LinkRow access="viewer" note={`Pinned to ${pinnedTo}`} {...row} />
    </DeliverSection>
  );
}
