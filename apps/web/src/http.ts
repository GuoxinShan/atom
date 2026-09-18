import type http from "node:http";
import fs from "node:fs";

export function json(res: http.ServerResponse, body: unknown, status = 200): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(data);
}

export function file(res: http.ServerResponse, p: string, type: string): void {
  const data = fs.readFileSync(p);
  res.writeHead(200, { "content-type": type });
  res.end(data);
}

export function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8").trim() || "{}";
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
