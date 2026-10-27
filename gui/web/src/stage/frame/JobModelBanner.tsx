import { JobModelDownload } from "../../models";
import { useDaw } from "../../state/useDaw";
import { jobErrorText, modelNeededOfJob } from "../../utils/apiError";

/**
 * Under the header while the latest job failed for a missing model: what
 * failed, and the Download that fixes it. Guests never see it.
 */
export function JobModelBanner({ guestShare }: { guestShare: boolean }) {
  const job = useDaw((s) => s.activityJob);
  if (guestShare || !job || !modelNeededOfJob(job)) return null;
  return (
    <div className="guest-banner" role="status">
      {jobErrorText(job)} <JobModelDownload job={job} />
    </div>
  );
}
