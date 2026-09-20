import { removeLiveE2eProject } from "./liveProject";

export default function globalTeardown(): void {
  removeLiveE2eProject();
}
