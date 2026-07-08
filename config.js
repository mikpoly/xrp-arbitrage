require("dotenv").config();
const xrpl = require("xrpl");

const NETWORKS = {
  testnet: ["wss://s.altnet.rippletest.net:51233"],
  mainnet: ["wss://xrplcluster.com", "wss://s1.ripple.com", "wss://s2.ripple.com"],
};

const MAINNET_ISSUERS = {
  USD_BITSTAMP: "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B",
  EUR_GATEHUB: "rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq",
  RLUSD: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
  SOLO: "rsoLo2S1kiGeCcn6hCUXVrCpGMWLrRrLZz",
};

function parseTokenList(name, raw) {
  if (!raw || raw.trim() === "") return [];

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((trimmed) => {
      const idx = trimmed.indexOf(".");

      if (idx === -1) {
        throw new Error(`${name} invalide "${trimmed}" — format attendu: CODE.rAdresseEmetteur`);
      }

      return {
        currency: trimmed.slice(0, idx),
        issuer: trimmed.slice(idx + 1),
      };
    });
}

function parseExtraTokens(raw) {
  return parseTokenList("EXTRA_TOKENS", raw);
}

function toNumber(name, raw, fallback) {
  const v = raw === undefined || raw === "" ? fallback : Number(raw);

  if (Number.isNaN(v)) {
    throw new Error(`Config invalide: ${name} doit être un nombre. Valeur reçue: "${raw}"`);
  }

  return v;
}

function toBool(raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  return String(raw).toLowerCase() === "true";
}

const NETWORK = (process.env.NETWORK || "testnet").toLowerCase();

if (!NETWORKS[NETWORK]) {
  throw new Error(`NETWORK invalide: "${NETWORK}". Utilise "testnet" ou "mainnet".`);
}

const config = {
  NETWORK,
  WS_URLS: NETWORKS[NETWORK],
  WS_URL: NETWORKS[NETWORK][0],
  WALLET_SEED: process.env.WALLET_SEED || null,

  MAX_TRADE_XRP: toNumber("MAX_TRADE_XRP", process.env.MAX_TRADE_XRP, 5),
  MIN_PROFIT_PCT: toNumber("MIN_PROFIT_PCT", process.env.MIN_PROFIT_PCT, 0.5),
  SLIPPAGE_BUFFER_PCT: toNumber("SLIPPAGE_BUFFER_PCT", process.env.SLIPPAGE_BUFFER_PCT, 0.3),
  MIN_XRP_RESERVE_BUFFER: toNumber("MIN_XRP_RESERVE_BUFFER", process.env.MIN_XRP_RESERVE_BUFFER, 5),

  DRY_RUN: toBool(process.env.DRY_RUN, true),

  SCAN_INTERVAL_MS: toNumber("SCAN_INTERVAL_MS", process.env.SCAN_INTERVAL_MS, 30000),
  MIN_SCAN_INTERVAL_MS: toNumber("MIN_SCAN_INTERVAL_MS", process.env.MIN_SCAN_INTERVAL_MS, 30000),
  LEDGER_TRIGGER_DEBOUNCE_MS: toNumber("LEDGER_TRIGGER_DEBOUNCE_MS", process.env.LEDGER_TRIGGER_DEBOUNCE_MS, 15000),
  BUSY_SCAN_LOG_THROTTLE_MS: toNumber("BUSY_SCAN_LOG_THROTTLE_MS", process.env.BUSY_SCAN_LOG_THROTTLE_MS, 30000),

  MAX_DAILY_LOSS_XRP: toNumber("MAX_DAILY_LOSS_XRP", process.env.MAX_DAILY_LOSS_XRP, 10),
  MAX_CONSECUTIVE_FAILURES: toNumber("MAX_CONSECUTIVE_FAILURES", process.env.MAX_CONSECUTIVE_FAILURES, 3),
  COOLDOWN_AFTER_BREAKER_MS: toNumber(
    "COOLDOWN_AFTER_BREAKER_MS",
    process.env.COOLDOWN_AFTER_BREAKER_MS,
    15 * 60 * 1000
  ),

  CONFIRM_FIRST_N_TRADES: toNumber("CONFIRM_FIRST_N_TRADES", process.env.CONFIRM_FIRST_N_TRADES, 0),

  LOG_LEVEL: (process.env.LOG_LEVEL || "INFO").toUpperCase(),

  DISCOVERY_MAX_TOKENS: toNumber("DISCOVERY_MAX_TOKENS", process.env.DISCOVERY_MAX_TOKENS, 25),
  DISCOVERY_LEDGERS_TO_SCAN: toNumber("DISCOVERY_LEDGERS_TO_SCAN", process.env.DISCOVERY_LEDGERS_TO_SCAN, 80),
  DISCOVERY_MIN_ACTIVITY: toNumber("DISCOVERY_MIN_ACTIVITY", process.env.DISCOVERY_MIN_ACTIVITY, 1),
  DISCOVERY_MIN_OFFERS: toNumber("DISCOVERY_MIN_OFFERS", process.env.DISCOVERY_MIN_OFFERS, 1),
  DISCOVERY_REQUIRE_BOTH_XRP_SIDES: toBool(process.env.DISCOVERY_REQUIRE_BOTH_XRP_SIDES, true),
  DISCOVERY_REFRESH_MS: toNumber("DISCOVERY_REFRESH_MS", process.env.DISCOVERY_REFRESH_MS, 20 * 60 * 1000),

  RATE_SCAN_ALL_PAIRS: toBool(process.env.RATE_SCAN_ALL_PAIRS, true),
  RATE_SCAN_CONCURRENCY: toNumber("RATE_SCAN_CONCURRENCY", process.env.RATE_SCAN_CONCURRENCY, 4),

  MAX_ARBITRAGE_HOPS: toNumber("MAX_ARBITRAGE_HOPS", process.env.MAX_ARBITRAGE_HOPS, 4),
  MAX_CANDIDATE_CYCLES: toNumber("MAX_CANDIDATE_CYCLES", process.env.MAX_CANDIDATE_CYCLES, 40),
  ORDERBOOK_DEPTH_LIMIT: toNumber("ORDERBOOK_DEPTH_LIMIT", process.env.ORDERBOOK_DEPTH_LIMIT, 50),

  // --- Diagnostic ancien moteur order-book ---
  // true = continue d'afficher les cycles XRP -> token -> ... -> XRP trouvés par le graphe,
  // mais sans jamais les exécuter si Amount et SendMax seraient tous les deux en XRP.
  ORDERBOOK_DIAGNOSTIC_SCAN: toBool(process.env.ORDERBOOK_DIAGNOSTIC_SCAN, true),

  // true = affiche ces cycles dans le dashboard comme opportunités de diagnostic.
  // false = les log seulement, et ne retourne que les opportunités Safe Rotation exécutables.
  ORDERBOOK_RETURN_DIAGNOSTIC: toBool(process.env.ORDERBOOK_RETURN_DIAGNOSTIC, true),

  // true = force l'ancien moteur order-book à rester en observation même si quelqu'un essaie
  // de le renvoyer vers l'exécution. À garder true sur mainnet.
  ORDERBOOK_NEVER_EXECUTE_XRP_CYCLE: toBool(process.env.ORDERBOOK_NEVER_EXECUTE_XRP_CYCLE, true),

  // --- Safe Payment / trustlines ---
  SAFE_TRUSTLINE_TOKENS: parseTokenList("SAFE_TRUSTLINE_TOKENS", process.env.SAFE_TRUSTLINE_TOKENS),
  SAFE_TRUSTLINE_LIMIT: process.env.SAFE_TRUSTLINE_LIMIT || "1000000000",
  SAFE_TRUSTLINE_DRY_RUN: toBool(process.env.SAFE_TRUSTLINE_DRY_RUN, true),

  SAFE_SCAN_XRP_TO_TOKEN: toBool(process.env.SAFE_SCAN_XRP_TO_TOKEN, true),
  SAFE_SCAN_TOKEN_TO_XRP: toBool(process.env.SAFE_SCAN_TOKEN_TO_XRP, true),
  SAFE_PAYMENT_MAX_TARGETS: toNumber("SAFE_PAYMENT_MAX_TARGETS", process.env.SAFE_PAYMENT_MAX_TARGETS, 50),
  SAFE_PAYMENT_DEPTH_LIMIT: toNumber("SAFE_PAYMENT_DEPTH_LIMIT", process.env.SAFE_PAYMENT_DEPTH_LIMIT, 120),

  // --- Rotation automatique sûre ---
  // Si tu possèdes déjà un token, le bot cherche d'abord une sortie token -> XRP.
  SAFE_EXIT_POSITIONS_FIRST: toBool(process.env.SAFE_EXIT_POSITIONS_FIRST, true),

  // true = le bot peut acheter automatiquement un token autorisé avec XRP.
  SAFE_ALLOW_XRP_TO_TOKEN_BUY: toBool(process.env.SAFE_ALLOW_XRP_TO_TOKEN_BUY, true),

  // true = évite d'acheter un nouveau token si tu possèdes déjà un token.
  SAFE_BUY_ONLY_WHEN_NO_TOKEN_BALANCE: toBool(process.env.SAFE_BUY_ONLY_WHEN_NO_TOKEN_BALANCE, true),

  // Ignore les poussières de tokens.
  SAFE_MIN_TOKEN_BALANCE: toNumber("SAFE_MIN_TOKEN_BALANCE", process.env.SAFE_MIN_TOKEN_BALANCE, 0.000001),

  DASHBOARD_ENABLED: toBool(process.env.DASHBOARD_ENABLED, true),
  DASHBOARD_PORT: toNumber("DASHBOARD_PORT", process.env.DASHBOARD_PORT, 4173),

  MAINNET_ISSUERS,
  EXTRA_TOKENS: parseExtraTokens(process.env.EXTRA_TOKENS),
};

function validate() {
  const errors = [];

  if (config.NETWORK === "mainnet" && !config.WALLET_SEED) {
    errors.push("NETWORK=mainnet mais WALLET_SEED est vide. Impossible de trader du vrai argent sans wallet.");
  }

  if (config.WALLET_SEED) {
    try {
      xrpl.Wallet.fromSeed(config.WALLET_SEED);
    } catch (e) {
      errors.push(`WALLET_SEED invalide: ${e.message}`);
    }
  }

  if (config.MAX_TRADE_XRP <= 0) errors.push("MAX_TRADE_XRP doit être > 0");
  if (config.MIN_PROFIT_PCT < 0) errors.push("MIN_PROFIT_PCT doit être >= 0");
  if (config.SLIPPAGE_BUFFER_PCT < 0) errors.push("SLIPPAGE_BUFFER_PCT doit être >= 0");
  if (config.SCAN_INTERVAL_MS < 1000) errors.push("SCAN_INTERVAL_MS doit être >= 1000");
  if (config.MIN_SCAN_INTERVAL_MS < 1000) errors.push("MIN_SCAN_INTERVAL_MS doit être >= 1000");
  if (config.LEDGER_TRIGGER_DEBOUNCE_MS < 1000) errors.push("LEDGER_TRIGGER_DEBOUNCE_MS doit être >= 1000");
  if (config.BUSY_SCAN_LOG_THROTTLE_MS < 1000) errors.push("BUSY_SCAN_LOG_THROTTLE_MS doit être >= 1000");
  if (config.MAX_DAILY_LOSS_XRP <= 0) errors.push("MAX_DAILY_LOSS_XRP doit être > 0");
  if (config.CONFIRM_FIRST_N_TRADES < 0) errors.push("CONFIRM_FIRST_N_TRADES doit être >= 0");
  if (config.DISCOVERY_MAX_TOKENS < 2) errors.push("DISCOVERY_MAX_TOKENS doit être >= 2");
  if (config.DISCOVERY_LEDGERS_TO_SCAN < 1) errors.push("DISCOVERY_LEDGERS_TO_SCAN doit être >= 1");
  if (config.RATE_SCAN_CONCURRENCY < 1) errors.push("RATE_SCAN_CONCURRENCY doit être >= 1");
  if (config.MAX_ARBITRAGE_HOPS < 2) errors.push("MAX_ARBITRAGE_HOPS doit être >= 2");
  if (config.ORDERBOOK_DEPTH_LIMIT < 1) errors.push("ORDERBOOK_DEPTH_LIMIT doit être >= 1");

  if (config.NETWORK === "mainnet" && !config.ORDERBOOK_NEVER_EXECUTE_XRP_CYCLE) {
    errors.push("ORDERBOOK_NEVER_EXECUTE_XRP_CYCLE=false interdit sur mainnet: un cycle XRP->...->XRP ne doit pas être envoyé comme Payment XRP->XRP.");
  }

  if (config.NETWORK === "mainnet" && config.MAX_TRADE_XRP > 1000) {
    errors.push("MAX_TRADE_XRP > 1000 sur mainnet : garde-fou de sécurité.");
  }

  for (const [name, address] of Object.entries(config.MAINNET_ISSUERS)) {
    if (!xrpl.isValidClassicAddress(address)) {
      errors.push(`MAINNET_ISSUERS.${name} = "${address}" n'est pas une adresse XRPL valide.`);
    }
  }

  for (const token of config.EXTRA_TOKENS) {
    if (!token.currency || token.currency === "XRP") {
      errors.push(`EXTRA_TOKENS: devise invalide: "${token.currency}"`);
    }

    if (!xrpl.isValidClassicAddress(token.issuer)) {
      errors.push(`EXTRA_TOKENS: émetteur invalide pour ${token.currency}: "${token.issuer}"`);
    }
  }

  for (const token of config.SAFE_TRUSTLINE_TOKENS) {
    if (!token.currency || token.currency === "XRP") {
      errors.push(`SAFE_TRUSTLINE_TOKENS: devise invalide: "${token.currency}"`);
    }

    if (!xrpl.isValidClassicAddress(token.issuer)) {
      errors.push(`SAFE_TRUSTLINE_TOKENS: émetteur invalide pour ${token.currency}: "${token.issuer}"`);
    }
  }

  if (Number(config.SAFE_TRUSTLINE_LIMIT) <= 0 || Number.isNaN(Number(config.SAFE_TRUSTLINE_LIMIT))) {
    errors.push("SAFE_TRUSTLINE_LIMIT doit être un nombre > 0");
  }

  if (config.SAFE_PAYMENT_MAX_TARGETS < 1) errors.push("SAFE_PAYMENT_MAX_TARGETS doit être >= 1");
  if (config.SAFE_PAYMENT_DEPTH_LIMIT < 1) errors.push("SAFE_PAYMENT_DEPTH_LIMIT doit être >= 1");
  if (config.SAFE_MIN_TOKEN_BALANCE < 0) errors.push("SAFE_MIN_TOKEN_BALANCE doit être >= 0");

  if (errors.length > 0) {
    throw new Error("Configuration invalide:\n  - " + errors.join("\n  - "));
  }
}

validate();

module.exports = config;