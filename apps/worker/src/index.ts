import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "./env";
import { adminAuth } from "./middleware/adminAuth";
import authRoutes from "./routes/auth";
import channelRoutes from "./routes/channels";
import dashboardRoutes from "./routes/dashboard";
import modelRoutes from "./routes/models";
import newapiChannelRoutes from "./routes/newapiChannels";
import newapiGroupRoutes from "./routes/newapiGroups";
import newapiUserRoutes from "./routes/newapiUsers";
import proxyRoutes from "./routes/proxy";
import settingsRoutes from "./routes/settings";
import siteRoutes from "./routes/sites";
import tokenRoutes from "./routes/tokens";
import usageRoutes from "./routes/usage";

const app = new Hono<AppEnv>({ strict: false });
app.use(
	"/api/*",
	cors({
		origin: (_origin, c) => {
			const allowed = c.env.CORS_ORIGIN ?? "*";
			return allowed === "*"
				? "*"
				: allowed.split(",").map((item: string) => item.trim());
		},
		allowHeaders: [
			"Content-Type",
			"Authorization",
			"x-api-key",
			"x-admin-token",
			"New-Api-User",
		],
		allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
	}),
);
app.use(
	"/v1/*",
	cors({
		origin: "*",
		allowHeaders: ["Content-Type", "Authorization", "x-api-key"],
		allowMethods: ["GET", "POST", "OPTIONS"],
	}),
);
app.use(
	"/v1beta/*",
	cors({
		origin: "*",
		allowHeaders: ["Content-Type", "Authorization", "x-api-key"],
		allowMethods: ["GET", "POST", "OPTIONS"],
	}),
);

app.use("/api/*", async (c, next) => {
	if (
		c.req.path === "/api/auth/login" ||
		c.req.path.startsWith("/api/channel") ||
		c.req.path.startsWith("/api/user") ||
		c.req.path.startsWith("/api/group")
	) {
		return next();
	}
	return adminAuth(c, next);
});

app.get("/health", (c) => c.json({ ok: true }));

app.route("/api/auth", authRoutes);
app.route("/api/channels", channelRoutes);
app.route("/api/sites", siteRoutes);
app.route("/api/models", modelRoutes);
app.route("/api/tokens", tokenRoutes);
app.route("/api/usage", usageRoutes);
app.route("/api/dashboard", dashboardRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/channel", newapiChannelRoutes);
app.route("/api/user", newapiUserRoutes);
app.route("/api/group", newapiGroupRoutes);

app.route("/v1", proxyRoutes);
app.route("/v1beta", proxyRoutes);

app.onError((err, c) => {
	console.error("[app:error]", {
		method: c.req.method,
		path: c.req.path,
		message: err.message,
		stack: err.stack,
	});

	if (
		c.req.path === "/api" ||
		c.req.path.startsWith("/api/") ||
		c.req.path === "/v1" ||
		c.req.path.startsWith("/v1/") ||
		c.req.path === "/v1beta" ||
		c.req.path.startsWith("/v1beta/")
	) {
		return c.json({ error: "Internal Server Error" }, 500);
	}

	return c.text("Internal Server Error", 500);
});

app.notFound(async (c) => {
	const path = c.req.path;
	if (
		path === "/api" ||
		path.startsWith("/api/") ||
		path === "/v1" ||
		path.startsWith("/v1/")
	) {
		return c.json({ error: "Not Found" }, 404);
	}
	const assets = (
		c.env as { ASSETS?: { fetch: (input: Request) => Promise<Response> } }
	).ASSETS;
	if (!assets) {
		return c.text("Not Found", 404);
	}

	const res = await assets.fetch(c.req.raw);
	if (res.status !== 404) {
		return res;
	}

	const accept = c.req.header("accept") ?? "";
	const isHtml = accept.includes("text/html");
	const isFile = path.includes(".");
	if (!isHtml || isFile) {
		return res;
	}

	const url = new URL(c.req.url);
	url.pathname = "/index.html";
	return assets.fetch(new Request(url.toString(), c.req.raw));
});

export default app;

export { CheckinScheduler } from "./services/checkin-scheduler";
