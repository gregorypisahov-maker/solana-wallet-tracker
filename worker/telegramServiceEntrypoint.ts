import "dotenv/config";
import { startTelegramAlertRelay } from "./telegramAlertRelay";

startTelegramAlertRelay();
void import("./telegramBot").catch((error) => {
  console.error("[telegram-service] Telegram command bot failed to start:", error);
  process.exit(1);
});
