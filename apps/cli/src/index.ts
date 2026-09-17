import {
  decideOnStore,
  digest,
  extract,
  ingest,
  projectCandidates,
  run,
} from "@atom/core";
import { createPipeline } from "@atom/adapters";

const USAGE = `ATOM — Append-only Timeline Of Matters · 事元

  pnpm atom run              ingest + extract + markdown digest
  pnpm atom ingest
  pnpm atom extract
  pnpm atom digest
  pnpm atom candidates
  pnpm atom approve <id>
  pnpm atom reject <id>
  pnpm atom ui               local kanban (http://127.0.0.1:3333)

Default source: fixture    extract: heuristic
Env: ATOM_SOURCE=fixture|yzj
     ATOM_EXTRACT_AGENT=heuristic|grok
     ATOM_GROK_BIN ATOM_GROK_MODEL ATOM_GROK_MAX_TURNS
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    process.stdout.write(USAGE);
    return;
  }
  if (cmd === "ui") {
    const { startUi } = await import("@atom/web/server");
    await startUi();
    return;
  }

  const { pipeline, store } = createPipeline();
  try {
    switch (cmd) {
      case "run": {
        const result = await run(pipeline);
        console.log(
          `run ok  ingested=${result.ingested} proposed=${result.proposed}\ndigest ${result.digestPath}`,
        );
        break;
      }
      case "ingest": {
        const r = await ingest(pipeline);
        console.log(`ingest ok  ingested=${r.ingested} skipped=${r.skipped}`);
        break;
      }
      case "extract": {
        const r = await extract(pipeline);
        console.log(`extract ok  proposed=${r.proposed} skipped=${r.skipped}`);
        break;
      }
      case "digest": {
        const r = digest(pipeline);
        console.log(`digest ${r.path}  candidates=${r.candidates.length}`);
        break;
      }
      case "candidates": {
        const list = projectCandidates(store.listAll());
        if (list.length === 0) {
          console.log("no candidates — run `pnpm atom run` first");
          break;
        }
        for (const c of list) {
          const refs = c.refs.map((r) => r.token).join(" ");
          console.log(
            `${c.status.padEnd(10)}  ${c.id}  ${c.confidence.toFixed(2)}  ${c.title}\n            refs: ${refs}`,
          );
        }
        break;
      }
      case "approve":
      case "reject": {
        const id = rest[0];
        if (!id) throw new Error(`${cmd} requires a candidate id`);
        const updated = decideOnStore(
          store,
          id,
          cmd === "approve" ? "accepted" : "rejected",
          rest.slice(1).join(" ") || undefined,
        );
        digest(pipeline);
        console.log(`${updated.status}  ${updated.id}  ${updated.title}`);
        break;
      }
      default:
        throw new Error(`unknown command: ${cmd}\n${USAGE}`);
    }
  } finally {
    store.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
