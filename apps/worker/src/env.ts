import type {
	D1Database,
	DurableObjectNamespace,
} from "@cloudflare/workers-types";

export type Bindings = {
	DB: D1Database;
	CORS_ORIGIN?: string;
	PROXY_UPSTREAM_TIMEOUT_MS?: string;
	CHECKIN_SCHEDULER: DurableObjectNamespace;
};

export type Variables = {
	adminSessionId?: string;
	newApiUserId?: string | null;
	tokenRecord?: unknown;
};

export type AppEnv = {
	Bindings: Bindings;
	Variables: Variables;
};

