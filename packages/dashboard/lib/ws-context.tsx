"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useWebSocket, type WSEvent } from "./use-websocket";

interface WSContextValue {
  connected: boolean;
  events: WSEvent[];
  send: (data: unknown) => void;
}

const WSContext = createContext<WSContextValue>({
  connected: false,
  events: [],
  send: () => {},
});

export function WSProvider({ children }: { children: ReactNode }) {
  const ws = useWebSocket();
  return <WSContext.Provider value={ws}>{children}</WSContext.Provider>;
}

export function useWSContext() {
  return useContext(WSContext);
}
