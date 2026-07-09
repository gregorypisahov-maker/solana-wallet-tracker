import "dotenv/config";
import { getConnection, fetchNewSignatures, getParsedTx, extractTrade } from "../lib/solana";
import { getSupabaseAdmin } from "../lib/supabase";
import { fetchTokenMarketData } from "../lib/tokenData";
import { computeScore } from "../lib/scoring";
import { sendTelegramAlert, formatConsensusAlert } from "../lib/telegram";

const POLL_INTERVAL_MINUTES = Number(process.env.POLL_INTERVAL_MINUTES ?? 5);
const SCALP_WINDOW_MINUTES = Number(process.env.SCALP_WINDOW_MINUTES ?? 5);
const MIN_WALLETS_FOR_ALERT = Number(process.env.MIN_WALLETS_FOR_ALERT ?? 3);
const ALERT_WINDOW_HOURS = Number(process.env.ALERT_WINDOW_HOURS ?? 24);

const supabase = getSupabaseAdmin();
const connection = getConnection();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRateLimitError(err: any) {
  const msg = String(err?.message ?? err ?? "");
  return msg.includes("429") || msg.includes("Too Many Requests");
}

async function withRetry<T>(label: string, fn: () => Promise<T>, retries = 3): Promise<T | null> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (isRateLimitError(err)) {
        const waitMs = 3000 * (i + 1);
        console.warn(`[429] ${label}. Waiting ${waitMs}ms before
