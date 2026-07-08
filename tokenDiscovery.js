const xrpl = require("xrpl");
const logger = require("./logger");
const config = require("./config");

/**
 * Découverte large des tokens actifs.
 *
 * Version debug améliorée :
 * - regarde les champs directs des transactions ;
 * - regarde aussi les métadonnées / AffectedNodes ;
 * - affiche les tokens analysés si DEBUG_TOKEN_DISCOVERY=true ;
 * - affiche les raisons de rejet ;
 * - affiche le nombre d'offres XRP->token et token->XRP.
 */

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return String(raw).toLowerCase() === "true";
}

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function shortToken(token, max = 48) {
  if (!token) return token;
  return token.length > max ? token.slice(0, max) + "..." : token;
}

function isValidTokenKey(tokenKey) {
  if (!tokenKey || typeof tokenKey !== "string") return false;

  const idx = tokenKey.indexOf(".");
  if (idx === -1) return false;

  const currency = tokenKey.slice(0, idx);
  const issuer = tokenKey.slice(idx + 1);

  if (!currency || currency === "XRP") return false;
  if (!issuer || !xrpl.isValidClassicAddress(issuer)) return false;

  return true;
}

function tokenKeyFromAmount(amount) {
  if (!amount || typeof amount !== "object") return null;
  if (!amount.currency || amount.currency === "XRP") return null;
  if (!amount.issuer) return null;

  const key = `${amount.currency}.${amount.issuer}`;
  return isValidTokenKey(key) ? key : null;
}

function addTokenFromAmount(set, amount) {
  const key = tokenKeyFromAmount(amount);
  if (key) set.add(key);
}

function scanObjectForTokens(obj, set, depth = 0) {
  if (!obj || typeof obj !== "object") return;
  if (depth > 6) return;

  addTokenFromAmount(set, obj);

  for (const value of Object.values(obj)) {
    if (!value || typeof value !== "object") continue;

    if (Array.isArray(value)) {
      for (const item of value) scanObjectForTokens(item, set, depth + 1);
    } else {
      scanObjectForTokens(value, set, depth + 1);
    }
  }
}

function extractTokensFromTx(tx, meta = null) {
  const tokens = new Set();

  const directFields = [
    tx.TakerGets,
    tx.TakerPays,
    tx.Amount,
    tx.SendMax,
    tx.DeliverMin,
    tx.LimitAmount,
  ];

  for (const field of directFields) {
    addTokenFromAmount(tokens, field);
  }

  if (meta) {
    scanObjectForTokens(meta, tokens);
  }

  return [...tokens];
}

async function discoverActiveTokens(client, { ledgersToScan = config.DISCOVERY_LEDGERS_TO_SCAN } = {}) {
  const counts = new Map();
  const debugDiscovery = envBool("DEBUG_TOKEN_DISCOVERY", false);
  const debugLedgerLimit = envNumber("DEBUG_LEDGER_LIMIT", 10);

  let currentIndex;
  try {
    currentIndex = await client.getLedgerIndex();
  } catch (err) {
    logger.error("Découverte: impossible de lire l'index du ledger courant", { error: err.message });
    return [];
  }

  for (let i = 0; i < ledgersToScan; i++) {
    const ledgerIndex = currentIndex - i;

    try {
      const response = await client.request({
        command: "ledger",
        ledger_index: ledgerIndex,
        transactions: true,
        expand: true,
      });

      const txs = response.result.ledger.transactions || [];
      let ledgerTokensFound = 0;

      for (const entry of txs) {
        const tx = entry.tx_json || entry.tx || entry;
        const meta = entry.metaData || entry.meta || entry.meta_data || null;

        if (!tx || !tx.TransactionType) continue;

        if (
          tx.TransactionType !== "OfferCreate" &&
          tx.TransactionType !== "Payment" &&
          tx.TransactionType !== "TrustSet"
        ) {
          continue;
        }

        const tokens = extractTokensFromTx(tx, meta);
        ledgerTokensFound += tokens.length;

        for (const token of tokens) {
          counts.set(token, (counts.get(token) || 0) + 1);
        }
      }

      if (debugDiscovery && i < debugLedgerLimit) {
        logger.debug("Découverte: ledger analysé", {
          ledgerIndex,
          txCount: txs.length,
          tokenMentionsFound: ledgerTokensFound,
          distinctTokensSoFar: counts.size,
        });
      }
    } catch (err) {
      logger.warn(`Découverte: lecture du ledger ${ledgerIndex} échouée, on continue`, {
        error: err.message,
      });
    }
  }

  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([token, count]) => ({ token, count }));

  logger.info(`Découverte: ${ranked.length} tokens distincts vus dans les ${ledgersToScan} derniers ledgers.`, {
    top20: ranked.slice(0, 20).map(({ token, count }) => `${shortToken(token, 30)} (${count})`),
  });

  if (debugDiscovery) {
    logger.debug("Découverte: top tokens détaillés", {
      top: ranked.slice(0, envNumber("DEBUG_TOKEN_LIMIT", 80)).map(({ token, count }) => ({
        token,
        count,
      })),
    });
  }

  return ranked;
}

async function countBookOffers(client, takerGets, takerPays, limit) {
  const response = await client.request({
    command: "book_offers",
    taker_gets: takerGets,
    taker_pays: takerPays,
    limit,
  });

  return (response.result.offers || []).length;
}

async function inspectLiquidity(
  client,
  tokenKey,
  {
    minOffers = config.DISCOVERY_MIN_OFFERS,
    requireBothSides = config.DISCOVERY_REQUIRE_BOTH_XRP_SIDES,
  } = {}
) {
  const idx = tokenKey.indexOf(".");

  if (idx === -1) {
    return {
      ok: false,
      buyOffersXrpToToken: 0,
      sellOffersTokenToXrp: 0,
      reason: "token_key_invalid",
    };
  }

  const tokenObj = {
    currency: tokenKey.slice(0, idx),
    issuer: tokenKey.slice(idx + 1),
  };

  if (!isValidTokenKey(tokenKey)) {
    return {
      ok: false,
      buyOffersXrpToToken: 0,
      sellOffersTokenToXrp: 0,
      reason: "issuer_invalid_or_malformed",
    };
  }

  const xrp = { currency: "XRP" };
  const limit = Math.max(minOffers, 5);

  try {
    const [buyCount, sellCount] = await Promise.all([
      // XRP -> token : on reçoit token, on paie XRP.
      countBookOffers(client, tokenObj, xrp, limit),

      // token -> XRP : on reçoit XRP, on paie token.
      countBookOffers(client, xrp, tokenObj, limit),
    ]);

    const ok = requireBothSides
      ? buyCount >= minOffers && sellCount >= minOffers
      : buyCount >= minOffers || sellCount >= minOffers;

    return {
      ok,
      buyOffersXrpToToken: buyCount,
      sellOffersTokenToXrp: sellCount,
      reason: ok ? "ok" : "not_enough_offers",
    };
  } catch (err) {
    return {
      ok: false,
      buyOffersXrpToToken: 0,
      sellOffersTokenToXrp: 0,
      reason: "book_offers_error",
      error: err.message,
    };
  }
}

async function hasAnyLiquidity(client, tokenKey, options = {}) {
  const result = await inspectLiquidity(client, tokenKey, options);
  return result.ok;
}

async function buildWatchlist(
  client,
  {
    maxTokens = config.DISCOVERY_MAX_TOKENS,
    ledgersToScan = config.DISCOVERY_LEDGERS_TO_SCAN,
    minActivity = config.DISCOVERY_MIN_ACTIVITY,
    minOffers = config.DISCOVERY_MIN_OFFERS,
    requireBothSides = config.DISCOVERY_REQUIRE_BOTH_XRP_SIDES,
  } = {}
) {
  const discovered = await discoverActiveTokens(client, { ledgersToScan });

  const watchlist = [];
  const debugDiscovery = envBool("DEBUG_TOKEN_DISCOVERY", false);
  const debugTokenLimit = envNumber("DEBUG_TOKEN_LIMIT", 80);

  let analyzed = 0;
  let skippedForActivity = 0;
  let rejectedForLiquidity = 0;

  for (const { token, count } of discovered) {
    if (watchlist.length >= maxTokens) break;

    analyzed++;

    if (count < minActivity) {
      skippedForActivity++;

      if (debugDiscovery && analyzed <= debugTokenLimit) {
        logger.debug("Analyse token découverte: rejet activité insuffisante", {
          token,
          recentActivity: count,
          minActivity,
        });
      }

      continue;
    }

    const liquidity = await inspectLiquidity(client, token, { minOffers, requireBothSides });

    if (debugDiscovery && analyzed <= debugTokenLimit) {
      logger.debug("Analyse token découverte", {
        token,
        short: shortToken(token),
        recentActivity: count,
        minOffers,
        requireBothSides,
        buyOffersXrpToToken: liquidity.buyOffersXrpToToken,
        sellOffersTokenToXrp: liquidity.sellOffersTokenToXrp,
        retained: liquidity.ok,
        reason: liquidity.reason,
        error: liquidity.error,
      });
    }

    if (liquidity.ok) {
      watchlist.push(token);

      logger.info(`Watchlist: ${shortToken(token, 40)} retenu`, {
        recentActivity: count,
        buyOffersXrpToToken: liquidity.buyOffersXrpToToken,
        sellOffersTokenToXrp: liquidity.sellOffersTokenToXrp,
        requireBothSides,
      });
    } else {
      rejectedForLiquidity++;

      logger.debug(`Watchlist: ${shortToken(token, 40)} écarté`, {
        recentActivity: count,
        reason: liquidity.reason,
        buyOffersXrpToToken: liquidity.buyOffersXrpToToken,
        sellOffersTokenToXrp: liquidity.sellOffersTokenToXrp,
        error: liquidity.error,
      });
    }
  }

  logger.info("Watchlist finale construite", {
    retainedTokens: watchlist.length,
    maxTokens,
    analyzed,
    skippedForActivity,
    rejectedForLiquidity,
    requireBothSides,
  });

  logger.info(`Watchlist finale: ${watchlist.length} tokens + XRP`, {
    tokens: watchlist.map((t) => shortToken(t, 45)),
  });

  return ["XRP", ...watchlist];
}

module.exports = {
  buildWatchlist,
  discoverActiveTokens,
  inspectLiquidity,
  hasAnyLiquidity,
  extractTokensFromTx,
  isValidTokenKey,
};