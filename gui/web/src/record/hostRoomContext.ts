import { createContext, useContext } from "react";
import type { HostRoom } from "./useHostRoom";

const HostRoomContext = createContext<HostRoom | null>(null);

export const HostRoomProvider = HostRoomContext.Provider;

export function useHostRoomContext(): HostRoom | null {
  return useContext(HostRoomContext);
}
