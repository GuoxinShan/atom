import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decideOnStore, projectCandidates, resolvePaths } from "@atom/core";
import { createPipeline } from "@atom/adapters";
import { renderKanban } from "./kanban.ts";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");

export function createApp(): Hono {
  const app = new Hono();

  app.get("/styles.css", (c) =>
    c.text(css, 200, { "Content-Type": "text/css; charset=utf-8" }),
  );

  app.get("/", (c) => {
    const { store } = createPipeline();
    try {
      return c.html(renderKanban(projectCandidates(store.listAll()), resolvePaths().dbPath));
    } finally {
      store.close();
    }
  });

  app.get("/api/candidates", (c) => {
    const { store } = createPipeline();
    try {
      return c.json({ candidates: projectCandidates(store.listAll()) });
    } finally {
      store.close();
    }
  });

  app.post("/candidates/:id/accept", (c) => formDecide(c, "accepted"));
  app.post("/candidates/:id/reject", (c) => formDecide(c, "rejected"));
  app.post("/api/candidates/:id/accept", (c) => jsonDecide(c, "accepted"));
  app.post("/api/candidates/:id/reject", (c) => jsonDecide(c, "rejected"));

  return app;
}

function formDecide(c: Context, decision: "accepted" | "rejected"): Response | Promise<Response> {
  const id = c.req.param("id");
  if (!id) return c.text("missing id", 400);
  const { store } = createPipeline();
  try {
    decideOnStore(store, id, decision);
    return c.redirect("/");
  } catch (err) {
    return c.text(err instanceof Error ? err.message : "error", 400);
  } finally {
    store.close();
  }
}

async function jsonDecide(c: Context, decision: "accepted" | "rejected") {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "missing id" }, 400);
  const { store } = createPipeline();
  try {
    const candidate = decideOnStore(store, id, decision);
    return c.json({ candidate });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "error" }, 400);
  } finally {
    store.close();
  }
}

export async function startUi(): Promise<void> {
  const port = Number(process.env.ATOM_UI_PORT ?? 3333);
  const app = createApp();
  console.log(`ATOM kanban  http://127.0.0.1:${port}`);
  serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
  await new Promise(() => {
    /* keep process alive */
  });
}
