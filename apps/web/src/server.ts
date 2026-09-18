import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDbPath } from "@atom/core";
import { createDaemon } from "./context.js";
import { handleApi } from "./routes.js";
import { file, json } from "./http.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.ATOM_WEB_PORT ?? 8787);

async function main() {
  const daemon = await createDaemon();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (await handleApi(req, res, url, daemon)) return;
      if (handleStatic(req, res, url)) return;
      json(res, { error: "not found" }, 404);
    } catch (err) {
      json(res, { error: (err as Error).message }, 500);
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`ATOM desk http://127.0.0.1:${port}`);
    console.log(`db: ${process.env.ATOM_DB ?? defaultDbPath(daemon.repoRoot)}`);
  });
}

function handleStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): boolean {
  if (req.method !== "GET") return false;
  if (url.pathname === "/" || url.pathname === "/index.html") {
    file(res, path.join(publicDir, "index.html"), "text/html; charset=utf-8");
    return true;
  }
  if (url.pathname === "/styles.css") {
    file(res, path.join(publicDir, "styles.css"), "text/css; charset=utf-8");
    return true;
  }
  if (url.pathname === "/app.js") {
    file(res, path.join(publicDir, "app.js"), "text/javascript; charset=utf-8");
    return true;
  }
  return false;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
