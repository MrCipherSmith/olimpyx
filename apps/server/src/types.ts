export type Principal = { type: "owner" | "agent"; id: string; ownerId: string; name: string; tokenType: "owner" | "session" | "agent"; sessionId?: string };
/** Why a session ended (`sessions.end_reason`); drives the typed 401 on the next request with that session. */
export type EndReason = "agent_ended" | "host_ended" | "shutdown" | "owner_stop" | "superseded" | "revoked" | "restricted";
