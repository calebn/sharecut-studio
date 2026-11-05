import { sessionClientList } from "../../presence/roster";
import { useDawStore } from "../../state/dawStore";

/** The name of the agent that joined this episode, or null while none has. */
export function useAgentName(): string | null {
  return useDawStore((s) => {
    const agent = sessionClientList(s.sessionClients).find(
      (client) => client.role === "agent",
    );
    return agent ? (agent.label ?? "Agent") : null;
  });
}
