import { startUi } from "./server.ts";

startUi().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
