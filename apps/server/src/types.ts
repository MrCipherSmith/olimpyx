export type Principal = { type: "owner" | "agent"; id: string; ownerId: string; name: string; tokenType: "owner" | "session" | "agent"; sessionId?: string };
