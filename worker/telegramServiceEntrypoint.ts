import "dotenv/config";
import { startTelegramAlertRelay } from "./telegramAlertRelay";

// Trade alerts are operationally more important than inbound Telegram commands.
// Keep the relay alive even if long-polling commands fail to start (for example,
// because another Telegram process temporarily owns getUpdates).
startTelegramAlertRelay();
void import("./telegramBot").catch((error) => {
  console.error("[telegram-service] Telegram command bot failed to start:", error);
  console.error("[telegram-service] Alert relay remains active.");
});
