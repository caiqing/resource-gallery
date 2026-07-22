import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "./config.js";
import { getDb } from "./db/client.js";
import { authMiddleware } from "./middleware/auth.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { downloadRoutes } from "./routes/downloads.js";
import { meRoutes } from "./routes/me.js";
import { publicRoutes, sharePageRoutes } from "./routes/public.js";
import { seed } from "./seed.js";

// init db + seed defaults
getDb();
seed();

const app = new Hono();

app.use(
  "*",
  cors({
    origin: config.corsOrigin,
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Set-Cookie"]
  })
);
app.use("*", authMiddleware);

app.get("/health", (c) => c.json({ ok: true, service: "resource-gallery-api" }));
app.route("/api/auth", authRoutes);
app.route("/api", publicRoutes);
app.route("/api/me", meRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api/downloads", downloadRoutes);
app.route("/s", sharePageRoutes);

// Guard: non-admin must not hit publish/import via mistaken public routes — already under /admin

app.onError((err, c) => {
  console.error(JSON.stringify({
    level: "error",
    event: "request.failed",
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    error: err.message
  }));
  return c.json({ error: "internal error" }, 500);
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`API listening on http://127.0.0.1:${info.port}`);
});
