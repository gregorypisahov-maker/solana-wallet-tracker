// storage.js
// Minimal JSON-file persistence. Swap for Supabase later (you already have
// it wired up for the tracker) — this keeps the paper trader dependency-free
// so you can validate the logic before touching your production DB.

const fs = require('fs');
const path = require('path');
const config = require('./config');

function ensureDataDir() {
  const dir = path.dirname(config.storage.tradesLogPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadTrades() {
  ensureDataDir();
  if (!fs.existsSync(config.storage.tradesLogPath)) return [];
  return JSON.parse(fs.readFileSync(config.storage.tradesLogPath, 'utf8'));
}

function saveTrades(trades) {
  ensureDataDir();
  fs.writeFileSync(config.storage.tradesLogPath, JSON.stringify(trades, null, 2));
}

function appendTrade(trade) {
  const trades = loadTrades();
  trades.push(trade);
  saveTrades(trades);
}

function loadState() {
  ensureDataDir();
  if (!fs.existsSync(config.storage.stateLogPath)) {
    return {
      bankrollSol: config.position.simulatedBankrollSol,
      dailyStartBankrollSol: config.position.simulatedBankrollSol,
      dailyResetDate: new Date().toDateString(),
      consecutiveLosses: 0,
      halted: false,
      haltReason: null,
    };
  }
  return JSON.parse(fs.readFileSync(config.storage.stateLogPath, 'utf8'));
}

function saveState(state) {
  ensureDataDir();
  fs.writeFileSync(config.storage.stateLogPath, JSON.stringify(state, null, 2));
}

module.exports = { loadTrades, saveTrades, appendTrade, loadState, saveState };
