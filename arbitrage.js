const config = require("./config");
const logger = require("./logger");
const { prepareWithStrictLedgerBound, submitReliable } = require("./txSubmitter");
const {
  walkBookDepth,
  findOpportunityViaOrderBooks,
  recheckOrderBookOpportunity,
} = require("./orderBookArbitrage");
const { nodeToCurrencyObj } = require("./marketRates");

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

function decimalString(value, precision = 15) {
  const n = Number(value);

  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Valeur décimale invalide: ${value}`);
  }

  let s = n.toPrecision(precision);

  if (s.includes("e") || s.includes("E")) {
    s = n.toFixed(precision);
  }

  s = s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

  if (s === "0") {
    throw new Error(`Valeur trop petite après conversion décimale: ${value}`);
  }

  return s;
}

function xrpToDropsFloor(xrpAmount) {
  const n = Number(xrpAmount);

  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Montant XRP invalide: ${xrpAmount}`);
  }

  return String(Math.floor(n * 1_000_000));
}

function xrpToDropsCeil(xrpAmount) {
  const n = Number(xrpAmount);

  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Montant XRP invalide: ${xrpAmount}`);
  }

  return String(Math.ceil(n * 1_000_000));
}

function dropsToXrp(drops) {
  return Number(drops) / 1_000_000;
}

function getEstimatedFeeXrp() {
  return envNumber("SAFE_ESTIMATED_FEE_XRP", 0.00002);
}

function getMinNetProfitXrp() {
  return envNumber("SAFE_MIN_NET_PROFIT_XRP", 0.00005);
}

function getMinDestinationXrp() {
  return envNumber("SAFE_MIN_DESTINATION_XRP", 0.05);
}

function getNetEstimatedProfitXrp(estimatedProfitXrp) {
  const gross = Number(estimatedProfitXrp);
  if (!Number.isFinite(gross)) return null;
  return gross - getEstimatedFeeXrp();
}

function passesProfitAfterFee(estimatedProfitXrp, meta = {}) {
  const net = getNetEstimatedProfitXrp(estimatedProfitXrp);
  const minNet = getMinNetProfitXrp();

  if (!Number.isFinite(net) || net < minNet) {
    logger.debug("Opportunité ignorée: gain estimé trop faible après frais", {
      estimatedProfitXrp,
      estimatedFeeXrp: getEstimatedFeeXrp(),
      netEstimatedProfitXrp: net,
      minNetProfitXrp: minNet,
      ...meta,
    });

    return false;
  }

  return true;
}

function isXrpAmount(amount) {
  return typeof amount === "string";
}

function isIssuedAmount(amount) {
  return (
    amount &&
    typeof amount === "object" &&
    amount.currency &&
    amount.currency !== "XRP" &&
    amount.issuer &&
    amount.value !== undefined
  );
}

function nodeKeyFromAmount(amount) {
  if (!amount || typeof amount !== "object") return null;
  if (!amount.currency || amount.currency === "XRP") return null;
  if (!amount.issuer) return null;
  return `${amount.currency}.${amount.issuer}`;
}

function tokenObjToNode(token) {
  if (!token || !token.currency || !token.issuer) return null;
  if (token.currency === "XRP") return null;
  return `${token.currency}.${token.issuer}`;
}

function shortNode(node, max = 36) {
  if (!node) return node;
  return node.length > max ? node.slice(0, max) + "..." : node;
}

function normalizeNodes(nodes) {
  const configured = (config.SAFE_TRUSTLINE_TOKENS || [])
    .map(tokenObjToNode)
    .filter(Boolean);

  return [...new Set([...(nodes || []), ...configured].filter((n) => n && n !== "XRP"))];
}

function issuedAmountFromNode(node, value) {
  const obj = nodeToCurrencyObj(node);

  if (obj.currency === "XRP") {
    throw new Error("issuedAmountFromNode ne peut pas être appelé avec XRP");
  }

  return {
    currency: obj.currency,
    issuer: obj.issuer,
    value: decimalString(value),
  };
}

async function loadTrustlines(client, account) {
  const trustlines = new Map();
  let marker = undefined;

  do {
    const response = await client.request({
      command: "account_lines",
      account,
      limit: 400,
      ...(marker ? { marker } : {}),
    });

    const lines = response.result.lines || [];

    for (const line of lines) {
      const node = `${line.currency}.${line.account}`;
      const balance = Number(line.balance || 0);
      const limit = Number(line.limit || 0);

      trustlines.set(node, {
        node,
        currency: line.currency,
        issuer: line.account,
        balance: Number.isFinite(balance) ? balance : 0,
        limit: Number.isFinite(limit) ? limit : 0,
        raw: line,
      });
    }

    marker = response.result.marker;
  } while (marker);

  return trustlines;
}

function getPositiveTokenBalances(trustlines, nodes) {
  const minBalance = envNumber("SAFE_MIN_TOKEN_BALANCE", config.SAFE_MIN_TOKEN_BALANCE || 0.000001);

  return nodes
    .map((node) => trustlines.get(node))
    .filter((line) => line && Number(line.balance) > minBalance)
    .sort((a, b) => Number(b.balance) - Number(a.balance));
}

function hasAnyPositiveTokenBalance(trustlines, nodes) {
  return getPositiveTokenBalances(trustlines, nodes).length > 0;
}

function hasReceiveCapacity(trustline, amount) {
  if (!trustline) return false;

  const balance = Number(trustline.balance || 0);
  const limit = Number(trustline.limit || 0);
  const wanted = Number(amount);

  if (!Number.isFinite(balance) || !Number.isFinite(limit) || !Number.isFinite(wanted)) return false;

  return limit - balance >= wanted;
}

async function quoteDirect(client, fromNode, toNode, payAmount, options = {}) {
  const fromObj = nodeToCurrencyObj(fromNode);
  const toObj = nodeToCurrencyObj(toNode);

  return walkBookDepth(client, toObj, fromObj, payAmount, {
    depthLimit: options.depthLimit || envNumber("SAFE_PAYMENT_DEPTH_LIMIT", config.SAFE_PAYMENT_DEPTH_LIMIT || 120),
  });
}

const PATH_FIND_COOLDOWN_MS = envNumber("PATH_FIND_COOLDOWN_MS", 5 * 60 * 1000);
let pathFindDisabledUntil = 0;
let lastPathFindWarnAt = 0;

function isNoPermissionError(err) {
  const code =
    err?.data?.error ||
    err?.errorCode ||
    err?.code ||
    err?.name ||
    "";

  const message =
    err?.data?.error_message ||
    err?.data?.message ||
    err?.message ||
    "";

  return (
    String(code).toLowerCase() === "nopermission" ||
    String(message).toLowerCase().includes("no permission") ||
    String(message).toLowerCase().includes("permission")
  );
}

function normalizePathFindResponse(response) {
  if (!response) return null;

  if (response.result && Array.isArray(response.result.alternatives)) {
    return response;
  }

  if (Array.isArray(response.alternatives)) {
    return {
      result: {
        alternatives: response.alternatives,
      },
    };
  }

  return response;
}

async function tryRipplePathFind(client, request) {
  const response = await client.request({
    command: "ripple_path_find",
    ...request,
  });

  return normalizePathFindResponse(response);
}

async function tryLivePathFind(client, request) {
  try {
    const response = await client.request({
      command: "path_find",
      subcommand: "create",
      ...request,
    });

    return normalizePathFindResponse(response);
  } finally {
    try {
      await client.request({
        command: "path_find",
        subcommand: "close",
      });
    } catch (_) {
      // Ignore volontairement.
    }
  }
}

async function requestPathFind(client, request, meta = {}) {
  const now = Date.now();

  if (now < pathFindDisabledUntil) {
    logger.debug("Path find ignoré temporairement: cooldown après noPermission", {
      remainingMs: pathFindDisabledUntil - now,
      ...meta,
    });

    return null;
  }

  try {
    return await tryRipplePathFind(client, request);
  } catch (err) {
    if (!isNoPermissionError(err)) {
      logger.debug("ripple_path_find indisponible ou sans chemin utilisable", {
        error: err.message,
        ...meta,
      });

      return null;
    }

    logger.debug("ripple_path_find refusé par le serveur, tentative avec path_find", {
      error: err.message,
      ...meta,
    });
  }

  try {
    return await tryLivePathFind(client, request);
  } catch (err) {
    if (isNoPermissionError(err)) {
      pathFindDisabledUntil = Date.now() + PATH_FIND_COOLDOWN_MS;

      if (Date.now() - lastPathFindWarnAt > PATH_FIND_COOLDOWN_MS) {
        lastPathFindWarnAt = Date.now();

        logger.warn(
          "Le serveur XRPL refuse ripple_path_find/path_find avec noPermission. " +
            "Le bot ne peut pas calculer de chemin Safe Rotation sur ce serveur. " +
            "Il va réessayer après cooldown.",
          {
            cooldownMs: PATH_FIND_COOLDOWN_MS,
            ...meta,
          }
        );
      }

      return null;
    }

    logger.debug("path_find indisponible ou sans chemin utilisable", {
      error: err.message,
      ...meta,
    });

    return null;
  }
}

function chooseBestXrpSourceAlternative(alternatives) {
  const valid = (alternatives || []).filter((alt) => typeof alt.source_amount === "string");
  valid.sort((a, b) => Number(a.source_amount) - Number(b.source_amount));
  return valid[0] || null;
}

function chooseBestIssuedSourceAlternative(alternatives, tokenNode) {
  const valid = (alternatives || []).filter((alt) => {
    const node = nodeKeyFromAmount(alt.source_amount);
    return node === tokenNode && Number(alt.source_amount.value) > 0;
  });

  valid.sort((a, b) => Number(a.source_amount.value) - Number(b.source_amount.value));
  return valid[0] || null;
}

function candidateBetterThan(current, candidate) {
  if (!candidate) return false;
  if (!current) return true;

  if (candidate.estimatedProfitPct !== current.estimatedProfitPct) {
    return candidate.estimatedProfitPct > current.estimatedProfitPct;
  }

  return candidate.estimatedProfitXrp > current.estimatedProfitXrp;
}

function toOrderBookDiagnosticOpportunity(opportunity) {
  if (!opportunity) return null;

  return {
    ...opportunity,
    source: "order_books_diagnostic",
    transactionKind: "diagnostic_orderbook_cycle",
    executable: false,
    amount: opportunity.destinationDrops || null,
    sendMax: opportunity.requiredSourceDrops || null,
    executionBlockedReason:
      "Cycle XRP->...->XRP détecté dans les carnets, mais gardé en diagnostic: " +
      "une transaction Payment XRPL ne peut pas avoir Amount et SendMax tous les deux en XRP.",
  };
}

async function findOrderBookDiagnosticOpportunity(client, params) {
  if (!envBool("ORDERBOOK_DIAGNOSTIC_SCAN", config.ORDERBOOK_DIAGNOSTIC_SCAN)) {
    return null;
  }

  const safeNodes = normalizeNodes(params.nodes);
  const nodesForGraph = safeNodes.length > 0 ? ["XRP", ...safeNodes] : params.nodes;

  const opportunity = await findOpportunityViaOrderBooks(client, {
    ...params,
    nodes: nodesForGraph,
  });

  if (!opportunity) return null;

  const diagnostic = toOrderBookDiagnosticOpportunity(opportunity);

  logger.warn("Cycle order-book détecté mais non envoyé", {
    estimatedProfitPct: Number(diagnostic.estimatedProfitPct.toFixed(6)),
    estimatedProfitXrp: Number(diagnostic.estimatedProfitXrp.toFixed(6)),
    cyclePath: diagnostic.cyclePath,
    reason: diagnostic.executionBlockedReason,
  });

  if (!envBool("ORDERBOOK_RETURN_DIAGNOSTIC", config.ORDERBOOK_RETURN_DIAGNOSTIC)) {
    return null;
  }

  return diagnostic;
}

async function quoteXrpToTokenCandidate(client, wallet, tokenNode, params, trustline) {
  const requiredPct = params.minProfitPct + params.slippageBufferPct;
  const startXrp = Number(params.startXrp);
  const directSourceDrops = Number(xrpToDropsCeil(startXrp));

  let directReceived;
  try {
    directReceived = await quoteDirect(client, "XRP", tokenNode, startXrp);
  } catch (err) {
    logger.debug("Safe Rotation XRP->token: cotation directe impossible", {
      token: shortNode(tokenNode),
      error: err.message,
    });
    return null;
  }

  if (!Number.isFinite(directReceived) || directReceived <= 0) return null;

  if (!hasReceiveCapacity(trustline, directReceived)) {
    logger.debug("Safe Rotation XRP->token ignoré: capacité trustline insuffisante", {
      token: shortNode(tokenNode),
      directReceived,
      balance: trustline.balance,
      limit: trustline.limit,
    });
    return null;
  }

  const destinationAmount = issuedAmountFromNode(tokenNode, directReceived);

  const response = await requestPathFind(
    client,
    {
      source_account: wallet.address,
      destination_account: wallet.address,
      destination_amount: destinationAmount,
      source_currencies: [{ currency: "XRP" }],
    },
    { mode: "xrp_to_token", token: shortNode(tokenNode) }
  );

  const best = response ? chooseBestXrpSourceAlternative(response.result.alternatives || []) : null;
  if (!best) return null;

  const requiredSourceDrops = Number(best.source_amount);
  if (!Number.isFinite(requiredSourceDrops) || requiredSourceDrops <= 0) return null;

  const maxSpendDrops = Math.ceil(requiredSourceDrops * (1 + params.slippageBufferPct / 100));
  const estimatedProfitDrops = directSourceDrops - maxSpendDrops;
  const estimatedProfitPct = (estimatedProfitDrops / maxSpendDrops) * 100;

  if (estimatedProfitPct < requiredPct) {
    logger.debug("Safe Rotation XRP->token rejeté: avantage insuffisant vs carnet direct", {
      token: shortNode(tokenNode),
      estimatedProfitPct,
      requiredPct,
      directSourceDrops,
      requiredSourceDrops,
      maxSpendDrops,
    });
    return null;
  }

  const estimatedProfitXrp = dropsToXrp(estimatedProfitDrops);

  if (!passesProfitAfterFee(estimatedProfitXrp, {
    token: shortNode(tokenNode),
    mode: "xrp_to_token",
  })) {
    return null;
  }

  return {
    source: "safe_rotation_xrp_to_token",
    transactionKind: "xrp_to_token",
    amount: destinationAmount,
    sendMax: String(maxSpendDrops),
    paths: best.paths_computed || [],
    estimatedProfitPct,
    estimatedProfitXrp,
    realizedPnlXrp: 0,
    targetNode: tokenNode,
    directBenchmark: {
      directSpendDrops: String(directSourceDrops),
      pathRequiredDrops: String(requiredSourceDrops),
      pathMaxSpendDrops: String(maxSpendDrops),
      directReceived,
    },
  };
}

async function findBestXrpToTokenOpportunity(client, wallet, params, trustlines) {
  if (!envBool("SAFE_SCAN_XRP_TO_TOKEN", config.SAFE_SCAN_XRP_TO_TOKEN)) return null;
  if (!envBool("SAFE_ALLOW_XRP_TO_TOKEN_BUY", config.SAFE_ALLOW_XRP_TO_TOKEN_BUY)) return null;

  const nodes = normalizeNodes(params.nodes);

  if (envBool("SAFE_BUY_ONLY_WHEN_NO_TOKEN_BALANCE", config.SAFE_BUY_ONLY_WHEN_NO_TOKEN_BALANCE)) {
    const positiveLines = getPositiveTokenBalances(trustlines, nodes);

    if (positiveLines.length > 0) {
      logger.info("Safe Rotation: achat XRP->token ignoré car un token est déjà détenu", {
        positiveTokenBalances: positiveLines.slice(0, 8).map((line) => ({
          token: shortNode(line.node),
          balance: line.balance,
        })),
        hint:
          "Si ce solde bloque trop le bot, augmente SAFE_MIN_TOKEN_BALANCE ou mets SAFE_BUY_ONLY_WHEN_NO_TOKEN_BALANCE=false dans .env.",
      });

      return null;
    }
  }

  const maxTargets = envNumber("SAFE_PAYMENT_MAX_TARGETS", config.SAFE_PAYMENT_MAX_TARGETS || 50);
  let scanned = 0;
  let skippedNoTrustline = 0;
  let bestCandidate = null;

  for (const tokenNode of nodes) {
    if (scanned >= maxTargets) break;

    const trustline = trustlines.get(tokenNode);

    if (!trustline) {
      skippedNoTrustline++;
      continue;
    }

    scanned++;

    const candidate = await quoteXrpToTokenCandidate(client, wallet, tokenNode, params, trustline);

    if (candidateBetterThan(bestCandidate, candidate)) {
      bestCandidate = {
        ...candidate,
        diagnostics: {
          scanned,
          skippedNoTrustline,
          mode: "best_xrp_to_token",
        },
      };
    }
  }

  if (bestCandidate) {
    logger.info("Meilleure opportunité Safe Rotation XRP -> token trouvée", {
      token: shortNode(bestCandidate.targetNode),
      estimatedProfitPct: Number(bestCandidate.estimatedProfitPct.toFixed(6)),
      estimatedSavingXrp: Number(bestCandidate.estimatedProfitXrp.toFixed(6)),
      amount: bestCandidate.amount,
      sendMaxDrops: bestCandidate.sendMax,
      scanned,
      skippedNoTrustline,
    });
  } else {
    logger.debug("Safe Rotation XRP->token terminé sans opportunité", {
      nodes: nodes.length,
      scanned,
      skippedNoTrustline,
      trustlines: trustlines.size,
    });
  }

  return bestCandidate;
}

async function quoteTokenToXrpCandidate(client, wallet, tokenNode, params, trustline) {
  const requiredPct = params.minProfitPct + params.slippageBufferPct;
  const targetXrp = Number(params.startXrp);
  const tokenBalance = Number(trustline.balance);

  if (!Number.isFinite(tokenBalance) || tokenBalance <= 0) return null;

  let directXrpForBalance;
  try {
    directXrpForBalance = await quoteDirect(client, tokenNode, "XRP", tokenBalance);
  } catch (err) {
    logger.debug("Safe Rotation token->XRP: cotation directe impossible", {
      token: shortNode(tokenNode),
      error: err.message,
    });
    return null;
  }

  if (!Number.isFinite(directXrpForBalance) || directXrpForBalance <= 0) return null;

  const desiredXrp = Math.min(targetXrp, directXrpForBalance);

  if (desiredXrp < getMinDestinationXrp()) {
    logger.debug("Safe Rotation token->XRP ignoré: montant XRP destination trop petit", {
      token: shortNode(tokenNode),
      desiredXrp,
      minDestinationXrp: getMinDestinationXrp(),
      tokenBalance,
      directXrpForBalance,
    });
    return null;
  }

  const desiredDrops = Number(xrpToDropsFloor(desiredXrp));
  if (!Number.isFinite(desiredDrops) || desiredDrops <= 0) return null;

  const directTokenNeeded = tokenBalance * (desiredXrp / directXrpForBalance);
  if (!Number.isFinite(directTokenNeeded) || directTokenNeeded <= 0) return null;

  const response = await requestPathFind(
    client,
    {
      source_account: wallet.address,
      destination_account: wallet.address,
      destination_amount: String(desiredDrops),
      source_currencies: [nodeToCurrencyObj(tokenNode)],
    },
    { mode: "token_to_xrp", token: shortNode(tokenNode) }
  );

  const best = response ? chooseBestIssuedSourceAlternative(response.result.alternatives || [], tokenNode) : null;
  if (!best) return null;

  const requiredToken = Number(best.source_amount.value);
  if (!Number.isFinite(requiredToken) || requiredToken <= 0) return null;
  if (requiredToken > tokenBalance) return null;

  const maxTokenSpend = requiredToken * (1 + params.slippageBufferPct / 100);
  if (maxTokenSpend > tokenBalance) return null;

  const savedToken = directTokenNeeded - maxTokenSpend;
  const estimatedProfitPct = (savedToken / maxTokenSpend) * 100;

  if (estimatedProfitPct < requiredPct) {
    logger.debug("Safe Rotation token->XRP rejeté: avantage insuffisant vs carnet direct", {
      token: shortNode(tokenNode),
      estimatedProfitPct,
      requiredPct,
      directTokenNeeded,
      requiredToken,
      maxTokenSpend,
    });
    return null;
  }

  const xrpPerTokenDirect = directXrpForBalance / tokenBalance;
  const estimatedProfitXrp = savedToken * xrpPerTokenDirect;

  if (!passesProfitAfterFee(estimatedProfitXrp, {
    token: shortNode(tokenNode),
    mode: "token_to_xrp",
    desiredXrp,
    desiredDrops,
  })) {
    return null;
  }

  const sendMax = issuedAmountFromNode(tokenNode, maxTokenSpend);

  return {
    source: "safe_rotation_token_to_xrp",
    transactionKind: "token_to_xrp",
    amount: String(desiredDrops),
    sendMax,
    paths: best.paths_computed || [],
    estimatedProfitPct,
    estimatedProfitXrp,
    realizedPnlXrp: estimatedProfitXrp,
    targetNode: "XRP",
    sourceNode: tokenNode,
    directBenchmark: {
      directTokenNeeded,
      pathRequiredToken: requiredToken,
      pathMaxTokenSpend: maxTokenSpend,
      desiredXrp,
      tokenBalance,
    },
  };
}

async function findBestTokenToXrpOpportunity(client, wallet, params, trustlines) {
  if (!envBool("SAFE_SCAN_TOKEN_TO_XRP", config.SAFE_SCAN_TOKEN_TO_XRP)) return null;

  const nodes = normalizeNodes(params.nodes);
  const positiveLines = getPositiveTokenBalances(trustlines, nodes);
  const maxTargets = envNumber("SAFE_PAYMENT_MAX_TARGETS", config.SAFE_PAYMENT_MAX_TARGETS || 50);

  let scanned = 0;
  let bestCandidate = null;

  for (const line of positiveLines) {
    if (scanned >= maxTargets) break;
    scanned++;

    const candidate = await quoteTokenToXrpCandidate(client, wallet, line.node, params, line);

    if (candidateBetterThan(bestCandidate, candidate)) {
      bestCandidate = {
        ...candidate,
        diagnostics: {
          scanned,
          positiveBalances: positiveLines.length,
          mode: "best_token_to_xrp",
        },
      };
    }
  }

  if (bestCandidate) {
    logger.info("Meilleure opportunité Safe Rotation token -> XRP trouvée", {
      token: shortNode(bestCandidate.sourceNode),
      estimatedProfitPct: Number(bestCandidate.estimatedProfitPct.toFixed(6)),
      estimatedProfitXrp: Number(bestCandidate.estimatedProfitXrp.toFixed(6)),
      amountDrops: bestCandidate.amount,
      sendMax: bestCandidate.sendMax,
      scanned,
      positiveBalances: positiveLines.length,
    });
  } else {
    logger.debug("Safe Rotation token->XRP terminé sans opportunité", {
      nodes: nodes.length,
      scanned,
      positiveBalances: positiveLines.length,
      trustlines: trustlines.size,
    });
  }

  return bestCandidate;
}

async function findOpportunity(
  client,
  wallet,
  {
    startXrp,
    minProfitPct,
    slippageBufferPct,
    mainnetIssuers,
    extraTokens,
    nodes,
  }
) {
  const safeNodes = normalizeNodes(nodes);

  const params = {
    startXrp,
    minProfitPct,
    slippageBufferPct,
    mainnetIssuers,
    extraTokens,
    nodes: safeNodes,
  };

  if (safeNodes.length === 0) {
    logger.info("Safe Rotation: aucune watchlist token disponible, scan Safe Rotation ignoré.");

    try {
      const diagnostic = await findOrderBookDiagnosticOpportunity(client, params);
      if (diagnostic) return diagnostic;
    } catch (err) {
      logger.warn("Diagnostic order-book impossible", {
        error: err.message,
      });
    }

    return null;
  }

  let trustlines;
  try {
    trustlines = await loadTrustlines(client, wallet.address);
  } catch (err) {
    logger.warn("Safe Rotation: impossible de lire les trustlines du wallet", {
      error: err.message,
    });
    return null;
  }

  const exitFirst = envBool("SAFE_EXIT_POSITIONS_FIRST", config.SAFE_EXIT_POSITIONS_FIRST);

  if (exitFirst) {
    const exitCandidate = await findBestTokenToXrpOpportunity(client, wallet, params, trustlines);
    if (exitCandidate) return exitCandidate;

    const buyCandidate = await findBestXrpToTokenOpportunity(client, wallet, params, trustlines);
    if (buyCandidate) return buyCandidate;
  } else {
    const opportunities = [];

    const buyCandidate = await findBestXrpToTokenOpportunity(client, wallet, params, trustlines);
    if (buyCandidate) opportunities.push(buyCandidate);

    const exitCandidate = await findBestTokenToXrpOpportunity(client, wallet, params, trustlines);
    if (exitCandidate) opportunities.push(exitCandidate);

    if (opportunities.length > 0) {
      opportunities.sort((a, b) => b.estimatedProfitPct - a.estimatedProfitPct);
      return opportunities[0];
    }
  }

  const configuredNodes = (config.SAFE_TRUSTLINE_TOKENS || [])
    .map(tokenObjToNode)
    .filter(Boolean);
  const positiveBalances = getPositiveTokenBalances(trustlines, safeNodes).length;

  logger.info("Aucune opportunité Safe Rotation exécutable trouvée", {
    tokensScanned: safeNodes.length,
    configuredSafeTokens: configuredNodes.length,
    trustlines: trustlines.size,
    positiveTokenBalances: positiveBalances,
    exitFirst,
    allowBuy: envBool("SAFE_ALLOW_XRP_TO_TOKEN_BUY", config.SAFE_ALLOW_XRP_TO_TOKEN_BUY),
    buyOnlyWhenNoTokenBalance: envBool(
      "SAFE_BUY_ONLY_WHEN_NO_TOKEN_BALANCE",
      config.SAFE_BUY_ONLY_WHEN_NO_TOKEN_BALANCE
    ),
  });

  try {
    const diagnostic = await findOrderBookDiagnosticOpportunity(client, params);
    if (diagnostic) return diagnostic;
  } catch (err) {
    logger.warn("Diagnostic order-book impossible", {
      error: err.message,
    });
  }

  return null;
}

async function recheckOpportunity(client, wallet, originalOpportunity, params) {
  if (originalOpportunity && originalOpportunity.executable === false) {
    const checked = await recheckOrderBookOpportunity(client, originalOpportunity, params);
    return checked ? toOrderBookDiagnosticOpportunity(checked) : null;
  }

  return findOpportunity(client, wallet, params);
}

function createNonExecutablePaymentError(opportunity, reason) {
  const err = new Error(`Opportunité ignorée: Payment XRPL non exécutable (${reason}).`);

  err.code = "LOCAL_UNEXECUTABLE_PAYMENT";
  err.doNotCountAsTradeFailure = true;
  err.opportunity = {
    source: opportunity ? opportunity.source : null,
    transactionKind: opportunity ? opportunity.transactionKind : null,
    estimatedProfitPct: opportunity ? opportunity.estimatedProfitPct : null,
    estimatedProfitXrp: opportunity ? opportunity.estimatedProfitXrp : null,
  };

  return err;
}

function validateExecutablePayment(opportunity) {
  if (opportunity && opportunity.executable === false) {
    throw createNonExecutablePaymentError(
      opportunity,
      opportunity.executionBlockedReason || "opportunité marquée diagnostic/non exécutable"
    );
  }

  if (
    opportunity &&
    config.ORDERBOOK_NEVER_EXECUTE_XRP_CYCLE !== false &&
    (opportunity.source === "order_books" || opportunity.source === "order_books_diagnostic")
  ) {
    throw createNonExecutablePaymentError(
      opportunity,
      "ancien cycle order-book bloqué par sécurité: utilise seulement les Safe Rotation exécutables"
    );
  }

  const amount = opportunity.amount || opportunity.destinationAmount || opportunity.destinationDrops;
  const sendMax = opportunity.sendMax || opportunity.requiredSourceAmount || opportunity.requiredSourceDrops;

  if (!amount) throw createNonExecutablePaymentError(opportunity, "Amount absent");
  if (!sendMax) throw createNonExecutablePaymentError(opportunity, "SendMax absent");

  if (isXrpAmount(amount) && isXrpAmount(sendMax)) {
    throw createNonExecutablePaymentError(
      opportunity,
      "Amount et SendMax sont tous les deux en XRP, ce qui provoque temBAD_SEND_XRP_MAX"
    );
  }

  if (!isXrpAmount(amount) && !isIssuedAmount(amount)) {
    throw createNonExecutablePaymentError(opportunity, "Amount invalide");
  }

  if (!isXrpAmount(sendMax) && !isIssuedAmount(sendMax)) {
    throw createNonExecutablePaymentError(opportunity, "SendMax invalide");
  }

  return { amount, sendMax };
}

async function executeOpportunity(client, xrplClient, wallet, opportunity, feeDrops) {
  const { amount, sendMax } = validateExecutablePayment(opportunity);

  const tx = {
    TransactionType: "Payment",
    Account: wallet.address,
    Destination: wallet.address,
    Amount: amount,
    SendMax: sendMax,
    Fee: feeDrops,
  };

  if (Array.isArray(opportunity.paths) && opportunity.paths.length > 0) {
    tx.Paths = opportunity.paths;
  }

  const { prepared, lastLedgerSequence } = await prepareWithStrictLedgerBound(client, xrplClient, tx);
  const signed = wallet.sign(prepared);

  logger.trade("Soumission de la transaction Safe Rotation", {
    hash: signed.hash,
    transactionKind: opportunity.transactionKind,
    amount,
    sendMax,
    source: opportunity.source || "safe_rotation",
    estimatedProfitPct: opportunity.estimatedProfitPct,
    estimatedProfitXrp: opportunity.estimatedProfitXrp,
    targetNode: opportunity.targetNode || null,
    sourceNode: opportunity.sourceNode || null,
    lastLedgerSequence,
  });

  const outcome = await submitReliable(client, xrplClient, signed, lastLedgerSequence);

  if (outcome.classification.category !== "success") {
    throw Object.assign(
      new Error(`Transaction non aboutie: ${outcome.finalResult} — ${outcome.classification.message}`),
      { outcome }
    );
  }

  return outcome;
}

module.exports = {
  findOpportunity,
  recheckOpportunity,
  executeOpportunity,
};