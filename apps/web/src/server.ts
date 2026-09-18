import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDb,
  defaultDbPath,
  EventStore,
  candidatesByStatus,
  approveCandidate,
  rejectCandidate,
  exportHandoff,
  listSpecDrafts,
  GrokCliCodingAgent,
  runColdStart,
  leadApplyConfig,
} from "@atom/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

function resolveRepoRoot(): string {
  let dir = path.resolve(process.cwd());
  for (;;) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const j = JSON.parse(fs.readFileSync(pkg, "utf8")) as { name?: string };
        if (j.name === "atom") return dir;
      } catch {
        /* ignore */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, "../../..");
}

const repoRoot = resolveRepoRoot();
const port = Number(process.env.ATOM_WEB_PORT ?? 8787);

async function main() {
  const atomDb = await openDb(process.env.ATOM_DB ?? defaultDbPath(repoRoot));
  const store = new EventStore(atomDb);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

      if (req.method === "GET" && url.pathname === "/api/candidates") {
        const status = url.searchParams.get("status") as
          | "suggested"
          | "accepted"
          | "rejected"
          | "merged"
          | null;
        const list = candidatesByStatus(store, status ?? undefined);
        return json(res, { candidates: list });
      }

      if (req.method === "POST" && url.pathname === "/api/approve") {
        const body = await readJson(req);
        const id = String(body.id ?? "");
        if (!id) return json(res, { error: "id required" }, 400);
        const { specId } = approveCandidate(store, id, body.note ? String(body.note) : undefined);
        return json(res, { ok: true, specId });
      }

      if (req.method === "POST" && url.pathname === "/api/reject") {
        const body = await readJson(req);
        const id = String(body.id ?? "");
        if (!id) return json(res, { error: "id required" }, 400);
        rejectCandidate(store, id, body.reason ? String(body.reason) : undefined);
        return json(res, { ok: true });
      }

      if (req.method === "GET" && url.pathname === "/api/specs") {
        return json(res, { specs: listSpecDrafts(store) });
      }

      if (req.method === "POST" && url.pathname === "/api/handoff") {
        const body = await readJson(req);
        const id = String(body.id ?? body.specId ?? body.candidateId ?? "");
        if (!id) return json(res, { error: "id required" }, 400);
        const run = Boolean(body.run);
        const coding = body.target === "file" ? undefined : new GrokCliCodingAgent({ repoRoot });
        const pack = await exportHandoff(store, repoRoot, id, coding, {
          run,
          target: body.target === "file" ? "file" : "grok-cli",
        });
        return json(res, { ok: true, pack });
      }

      // Inbound webhook Trigger seam: POST /hooks/run → pipeline not auto here (manual ack)
      
      if (req.method === "GET" && url.pathname === "/api/setup") {
        return json(res, runColdStart(repoRoot));
      }

      if (req.method === "GET" && url.pathname === "/api/sources") {
        const raw = fs.readFileSync(path.join(repoRoot, "data/sources.json"), "utf8");
        return json(res, JSON.parse(raw));
      }

      if (req.method === "GET" && url.pathname === "/api/subscriptions") {
        const pth = path.join(repoRoot, "data/subscriptions.json");
        const raw = fs.existsSync(pth) ? fs.readFileSync(pth, "utf8") : '{"subscriptions":[]}';
        return json(res, JSON.parse(raw));
      }

      if (req.method === "GET" && url.pathname === "/api/workspaces") {
        const raw = fs.readFileSync(path.join(repoRoot, "data/workspaces.json"), "utf8");
        return json(res, JSON.parse(raw));
      }

      if (req.method === "POST" && url.pathname === "/api/lead") {
        const body = await readJson(req);
        const utterance = String(body.utterance ?? body.text ?? "");
        if (!utterance.trim()) return json(res, { error: "utterance required" }, 400);
        const result = leadApplyConfig(repoRoot, utterance);
        return json(res, result, result.ok ? 200 : 400);
      }


      if (req.method === "POST" && url.pathname.startsWith("/hooks/")) {
        const body = await readJson(req);
        console.log(`[hook] ${url.pathname}`, body);
        return json(res, { ok: true, received: true, path: url.pathname, note: "stub — wire to atom run next" });
      }

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return file(res, path.join(publicDir, "index.html"), "text/html; charset=utf-8");
      }
      if (req.method === "GET" && url.pathname === "/styles.css") {
        return file(res, path.join(publicDir, "styles.css"), "text/css; charset=utf-8");
      }
      if (req.method === "GET" && url.pathname === "/app.js") {
        return file(res, path.join(publicDir, "app.js"), "text/javascript; charset=utf-8");
      }

      json(res, { error: "not found" }, 404);
    } catch (err) {
      json(res, { error: (err as Error).message }, 500);
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`ATOM kanban http://127.0.0.1:${port}`);
    console.log(`db: ${process.env.ATOM_DB ?? defaultDbPath(repoRoot)}`);
  });
}

function json(res: http.ServerResponse, body: unknown, status = 200) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(data);
}

function file(res: http.ServerResponse, p: string, type: string) {
  const data = fs.readFileSync(p);
  res.writeHead(200, { "content-type": type });
  res.end(data);
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8") || "{}";
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
