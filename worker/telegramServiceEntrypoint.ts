import "dotenv/config";
import { startTelegramAlertRelay } from "./telegramAlertRelay";

startTelegramAlertRelay();
await import("./telegramBot");
