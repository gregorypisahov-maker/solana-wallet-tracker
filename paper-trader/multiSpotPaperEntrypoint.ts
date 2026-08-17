import "dotenv/config";
import { MultiSpotPaperBot } from "./multiSpotPaper";

const bot = new MultiSpotPaperBot();

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

bot.start().catch((error) => {
  console.error("[multi-spot-paper] fatal", error);
  process.exit(1);
});
