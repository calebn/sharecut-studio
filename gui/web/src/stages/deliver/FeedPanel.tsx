import type { Fix } from "../../types/feedView";
import { FeedSection } from "./FeedSection";
import { EMPTY_VIEW, type FeedAccess, type SourceOwner } from "./feedLogic";
import { useFeed } from "./useFeed";

type Props = {
  /** The host's project path, or a share key. */
  projectPath: string;
  access: FeedAccess;
  /** Reload when this changes, such as the project's history head or the finish of an export. */
  refreshKey?: string;
  /** A command only the host's app can run, such as exporting. */
  onCommand?: (fix: Fix) => void;
  onOpenSource: (owner: SourceOwner) => void;
};

/** The Podcast listing on the real service: loads it, sends each edit and the write, and shows what the service answers. */
function FeedBody({
  projectPath,
  access,
  refreshKey,
  onCommand,
  onOpenSource,
}: Props) {
  const feed = useFeed(projectPath, {
    access,
    refreshKey,
    onCommand,
  });
  return (
    <FeedSection
      view={feed.served?.view ?? EMPTY_VIEW}
      itemXml={feed.served?.itemXml ?? ""}
      state={
        feed.served ? "ready" : feed.load === "error" ? "error" : "loading"
      }
      access={access}
      request={feed.request}
      problem={feed.problem}
      onAction={feed.act}
      onRetry={feed.refresh}
      onDismissProblem={feed.dismissProblem}
      onOpenSource={onOpenSource}
    />
  );
}

export function FeedPanel(props: Props) {
  return <FeedBody key={props.projectPath} {...props} />;
}
