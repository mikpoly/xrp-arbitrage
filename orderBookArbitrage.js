const logger = require("./logger");
const config = require("./config");
const { fetchAllRates, nodeToCurrencyObj, amountValue } = require("./marketRates");

const RLUSD_HEX = "524C555344000000000000000000000000000000";
const SOLO_HEX = "534F4C4F00000000000000000000000000000000";

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

function shortNode(node, max = 28) {
  if (!node) return node;
  return node.length > max ? node.slice(0, max) + "..." : node;
}

function shortPath(pathNodes) {
  return pathNodes.map((n) => shortNode(n, 24)).join(" -> ");
}

function buildDefaultNodes(mainnetIssuers, extraTokens = []) {
  const nodes = [
    "XRP",
    `USD.${mainnetIssuers.USD_BITSTAMP}`,
    `EUR.${mainnetIssuers.EUR_GATEHUB}`,
    `${RLUSD_HEX}.${mainnetIssuers.RLUSD}`,
    `${SOLO_HEX}.${mainnetIssuers.SOLO}`,
  ];

  for (const t of extraTokens || []) {
    nodes.push(`${t.currency}.${t.issuer}`);
  }

  return [...new Set(nodes)];
}

/**
 * Conversion XRP -> drops sans utiliser xrpl.xrpToDrops().
 *
 * xrpl.xrpToDrops() refuse les nombres avec plus de 6 décimales.
 * Nos calculs de profondeur peuvent produire 1.0331251905276155 XRP,
 * donc on arrondit nous-mêmes en drops.
 */
function xrpToDropsFloor(xrpAmount) {
  const n = Number(xrpAmount);

  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Montant XRP invalide pour xrpToDropsFloor: ${xrpAmount}`);
  }

  return String(Math.floor(n * 1_000_000));
}

function xrpToDropsCeil(xrpAmount) {
  const n = Number(xrpAmount);

  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Montant XRP invalide pour xrpToDropsCeil: ${xrpAmount}`);
  }

  return String(Math.ceil(n * 1_000_000));
}

async function walkBookDepth(client, getCurrency, payCurrency, payAmount, options = {}) {
  const limit = options.depthLimit || config.ORDERBOOK_DEPTH_LIMIT;
  const debugDepth = envBool("DEBUG_BOOK_DEPTH", false);

  const response = await client.request({
    command: "book_offers",
    taker_gets: getCurrency,
    taker_pays: payCurrency,
    limit,
  });

  const offers = response.result.offers || [];

  if (offers.length === 0) {
    if (debugDepth) {
      logger.debug("Carnet vide pendant walkBookDepth", {
        getCurrency,
        payCurrency,
        payAmount,
      });
    }

    return null;
  }

  let remainingPay = payAmount;
  let totalGet = 0;
  let usedOffers = 0;

  for (const offer of offers) {
    const offerGets = amountValue(offer.TakerGets);
    const offerPays = amountValue(offer.TakerPays);

    if (!Number.isFinite(offerGets) || !Number.isFinite(offerPays)) continue;
    if (offerGets <= 0 || offerPays <= 0) continue;

    const rate = offerGets / offerPays;
    const payUsedHere = Math.min(remainingPay, offerPays);

    totalGet += payUsedHere * rate;
    remainingPay -= payUsedHere;
    usedOffers++;

    if (remainingPay <= 1e-12) break;
  }

  if (remainingPay > 1e-12) {
    if (debugDepth) {
      logger.debug("Profondeur insuffisante dans le carnet", {
        getCurrency,
        payCurrency,
        payAmount,
        totalGet,
        remainingPay,
        offersAvailable: offers.length,
        usedOffers,
      });
    }

    return null;
  }

  if (debugDepth) {
    logger.debug("Carnet consommé avec succès", {
      getCurrency,
      payCurrency,
      payAmount,
      totalGet,
      usedOffers,
      offersAvailable: offers.length,
    });
  }

  return totalGet;
}

async function evaluatePath(client, pathNodes, startXrp, options = {}) {
  let currentAmount = startXrp;
  const steps = [];

  for (let i = 0; i < pathNodes.length - 1; i++) {
    const fromNode = pathNodes[i];
    const toNode = pathNodes[i + 1];

    const fromObj = nodeToCurrencyObj(fromNode);
    const toObj = nodeToCurrencyObj(toNode);

    const before = currentAmount;

    const received = await walkBookDepth(client, toObj, fromObj, currentAmount, options);

    if (received === null) {
      return {
        ok: false,
        reason: "depth_insufficient",
        failedStep: {
          index: i,
          from: fromNode,
          to: toNode,
          payAmount: before,
        },
        pathNodes,
      };
    }

    currentAmount = received;

    steps.push({
      index: i,
      from: fromNode,
      to: toNode,
      paid: before,
      received,
      rate: before > 0 ? received / before : null,
    });
  }

  const finalXrp = currentAmount;
  const profitXrp = finalXrp - startXrp;
  const profitPct = (profitXrp / startXrp) * 100;

  return {
    ok: true,
    profitPct,
    profitXrp,
    finalXrp,
    paths: [pathNodes.slice(1, -1).map((n) => nodeToCurrencyObj(n))],
    pathNodes,
    steps,
  };
}

function buildOpportunityFromEvaluation(evaluation, startXrp, requiredPct, source = "order_books") {
  if (!evaluation || evaluation.ok === false) {
    return {
      ok: false,
      rejectReason: evaluation ? evaluation.reason : "evaluation_null",
      evaluation,
    };
  }

  if (evaluation.profitPct < requiredPct) {
    return {
      ok: false,
      rejectReason: "real_profit_insufficient",
      evaluation,
    };
  }

  const requiredSourceDrops = xrpToDropsCeil(startXrp);
  const destinationDrops = xrpToDropsFloor(evaluation.finalXrp);

  const requiredSourceXrp = Number(requiredSourceDrops) / 1_000_000;
  const destinationXrp = Number(destinationDrops) / 1_000_000;

  const estimatedProfitXrp = destinationXrp - requiredSourceXrp;
  const estimatedProfitPct = (estimatedProfitXrp / requiredSourceXrp) * 100;

  if (!Number.isFinite(estimatedProfitPct) || !Number.isFinite(estimatedProfitXrp)) {
    return {
      ok: false,
      rejectReason: "profit_not_numeric_after_drops_rounding",
      evaluation,
      requiredSourceDrops,
      destinationDrops,
    };
  }

  if (Number(destinationDrops) <= Number(requiredSourceDrops)) {
    return {
      ok: false,
      rejectReason: "profit_disappeared_after_drops_rounding",
      evaluation,
      requiredSourceDrops,
      destinationDrops,
      estimatedProfitPct,
      estimatedProfitXrp,
    };
  }

  if (estimatedProfitPct < requiredPct) {
    return {
      ok: false,
      rejectReason: "profit_below_required_after_drops_rounding",
      evaluation,
      requiredSourceDrops,
      destinationDrops,
      estimatedProfitPct,
      estimatedProfitXrp,
    };
  }

  return {
    ok: true,
    opportunity: {
      requiredSourceDrops,
      destinationDrops,
      paths: evaluation.paths,
      estimatedProfitPct,
      estimatedProfitXrp,
      cyclePath: evaluation.pathNodes,
      source,
    },
  };
}

async function recheckOrderBookOpportunity(
  client,
  originalOpportunity,
  {
    startXrp,
    minProfitPct,
    slippageBufferPct,
  }
) {
  const cyclePath = originalOpportunity && (originalOpportunity.cyclePath || originalOpportunity.pathNodes);

  if (!Array.isArray(cyclePath) || cyclePath.length < 3) {
    logger.debug("Re-vérification rapide impossible: cycle absent ou invalide", {
      source: originalOpportunity ? originalOpportunity.source : null,
    });

    return null;
  }

  const requiredPct = minProfitPct + slippageBufferPct;

  let evaluation;
  try {
    evaluation = await evaluatePath(client, cyclePath, startXrp, {
      depthLimit: config.ORDERBOOK_DEPTH_LIMIT,
    });
  } catch (err) {
    logger.warn("Re-vérification rapide du cycle impossible", {
      error: err.message,
      cycle: cyclePath,
      shortPath: shortPath(cyclePath),
    });

    return null;
  }

  const rebuilt = buildOpportunityFromEvaluation(evaluation, startXrp, requiredPct, "order_books");

  if (!rebuilt.ok) {
    logger.info("Opportunité rejetée à la re-vérification rapide", {
      reason: rebuilt.rejectReason,
      beforeProfitPct: originalOpportunity.estimatedProfitPct,
      realPct: evaluation && evaluation.ok ? Number(evaluation.profitPct.toFixed(6)) : null,
      requiredPct,
      cycle: shortPath(cyclePath),
    });

    return null;
  }

  logger.info("Opportunité confirmée par re-vérification rapide", {
    estimatedProfitPct: Number(rebuilt.opportunity.estimatedProfitPct.toFixed(6)),
    estimatedProfitXrp: Number(rebuilt.opportunity.estimatedProfitXrp.toFixed(6)),
    cycle: shortPath(cyclePath),
  });

  return rebuilt.opportunity;
}

function buildAdjacency(rateMap) {
  const adjacency = new Map();

  for (const [fromTo, rate] of rateMap.entries()) {
    if (!rate || rate <= 0) continue;

    const [from, to] = fromTo.split("=>");
    if (!from || !to) continue;

    if (!adjacency.has(from)) {
      adjacency.set(from, []);
    }

    adjacency.get(from).push({ to, rate });
  }

  for (const list of adjacency.values()) {
    list.sort((a, b) => b.rate - a.rate);
  }

  return adjacency;
}

/**
 * Génère plusieurs cycles candidats qui commencent et finissent par XRP.
 */
function findCandidateCyclesFromXrp(rateMap, options = {}) {
  const source = options.source || "XRP";
  const maxHops = options.maxHops || config.MAX_ARBITRAGE_HOPS;
  const maxCandidates = options.maxCandidates || config.MAX_CANDIDATE_CYCLES;

  const adjacency = buildAdjacency(rateMap);
  const candidates = [];

  function dfs(current, path, product, visited) {
    const hopsUsed = path.length - 1;

    if (hopsUsed >= maxHops) {
      return;
    }

    const edges = adjacency.get(current) || [];

    for (const edge of edges) {
      const next = edge.to;

      if (next === source) {
        if (path.length >= 2) {
          const cycle = [...path, source];
          const cycleProduct = product * edge.rate;

          if (cycleProduct > 1) {
            candidates.push({
              pathNodes: cycle,
              product: cycleProduct,
              grossProfitPct: (cycleProduct - 1) * 100,
            });
          }
        }

        continue;
      }

      if (visited.has(next)) {
        continue;
      }

      visited.add(next);
      dfs(next, [...path, next], product * edge.rate, visited);
      visited.delete(next);
    }
  }

  dfs(source, [source], 1, new Set([source]));

  candidates.sort((a, b) => b.product - a.product);

  return candidates.slice(0, maxCandidates);
}

function summarizeRates(rateMap, limit = 30) {
  const rows = [];

  for (const [fromTo, rate] of rateMap.entries()) {
    const [from, to] = fromTo.split("=>");

    rows.push({
      from: shortNode(from),
      to: shortNode(to),
      rate,
    });
  }

  rows.sort((a, b) => b.rate - a.rate);

  return rows.slice(0, limit).map((r) => ({
    from: r.from,
    to: r.to,
    rate: Number(r.rate.toPrecision(8)),
  }));
}

async function findOpportunityViaOrderBooks(
  client,
  {
    startXrp,
    minProfitPct,
    slippageBufferPct,
    mainnetIssuers,
    extraTokens,
    nodes,
  }
) {
  const nodeList =
    nodes && nodes.length > 1
      ? [...new Set(nodes)]
      : buildDefaultNodes(mainnetIssuers, extraTokens || []);

  const debugRateSample = envBool("DEBUG_RATE_SAMPLE", false);
  const debugCycleRejections = envBool("DEBUG_CYCLE_REJECTIONS", false);
  const debugCandidateLimit = envNumber("DEBUG_CANDIDATE_LIMIT", 20);

  let rateMap;

  try {
    rateMap = await fetchAllRates(client, nodeList, {
      concurrency: config.RATE_SCAN_CONCURRENCY,
      scanAllPairs: config.RATE_SCAN_ALL_PAIRS,
    });
  } catch (err) {
    logger.warn("Erreur lors de la récupération des taux du marché", {
      error: err.message,
    });

    return null;
  }

  if (!rateMap || rateMap.size === 0) {
    logger.debug("Aucun taux trouvé dans les carnets.", {
      nodes: nodeList.length,
    });

    return null;
  }

  if (debugRateSample) {
    logger.debug("Échantillon des meilleurs taux trouvés", {
      nodes: nodeList.length,
      ratesFound: rateMap.size,
      sample: summarizeRates(rateMap, envNumber("DEBUG_RATE_SAMPLE_LIMIT", 30)),
    });
  }

  const candidates = findCandidateCyclesFromXrp(rateMap, {
    source: "XRP",
    maxHops: config.MAX_ARBITRAGE_HOPS,
    maxCandidates: config.MAX_CANDIDATE_CYCLES,
  });

  if (candidates.length === 0) {
    logger.debug("Aucun cycle rentable trouvé au top-of-book.", {
      nodes: nodeList.length,
      rates: rateMap.size,
    });

    return null;
  }

  logger.info("Cycles candidats top-of-book trouvés", {
    count: candidates.length,
    best: candidates.slice(0, 5).map((c) => ({
      grossProfitPct: Number(c.grossProfitPct.toFixed(4)),
      path: shortPath(c.pathNodes),
    })),
  });

  if (debugCycleRejections) {
    logger.debug("Cycles candidats top-of-book détaillés", {
      count: candidates.length,
      candidates: candidates.slice(0, debugCandidateLimit).map((c) => ({
        grossProfitPct: Number(c.grossProfitPct.toFixed(6)),
        product: Number(c.product.toPrecision(10)),
        path: c.pathNodes,
        shortPath: shortPath(c.pathNodes),
      })),
    });
  }

  const requiredPct = minProfitPct + slippageBufferPct;

  let rejectedDepth = 0;
  let rejectedRealProfit = 0;
  let rejectedRounding = 0;
  let rejectedInvalid = 0;

  for (const candidate of candidates) {
    let evaluation;

    try {
      evaluation = await evaluatePath(client, candidate.pathNodes, startXrp, {
        depthLimit: config.ORDERBOOK_DEPTH_LIMIT,
      });
    } catch (err) {
      rejectedInvalid++;

      logger.warn("Erreur en vérifiant un cycle candidat en profondeur", {
        error: err.message,
        cycle: candidate.pathNodes,
      });

      continue;
    }

    if (!evaluation || evaluation.ok === false) {
      rejectedDepth++;

      if (debugCycleRejections) {
        logger.debug("Cycle candidat rejeté: profondeur insuffisante", {
          topOfBookPct: Number(candidate.grossProfitPct.toFixed(6)),
          startXrp,
          depthLimit: config.ORDERBOOK_DEPTH_LIMIT,
          reason: evaluation ? evaluation.reason : "evaluation_null",
          failedStep: evaluation ? evaluation.failedStep : null,
          cycle: candidate.pathNodes,
          shortPath: shortPath(candidate.pathNodes),
        });
      }

      continue;
    }

    if (evaluation.profitPct < requiredPct) {
      rejectedRealProfit++;

      if (debugCycleRejections) {
        logger.debug("Cycle candidat rejeté: profit réel insuffisant", {
          topOfBookPct: Number(candidate.grossProfitPct.toFixed(6)),
          realPct: Number(evaluation.profitPct.toFixed(6)),
          realProfitXrp: Number(evaluation.profitXrp.toFixed(8)),
          finalXrp: Number(evaluation.finalXrp.toFixed(8)),
          requiredPct,
          startXrp,
          steps: evaluation.steps.map((s) => ({
            index: s.index,
            from: shortNode(s.from),
            to: shortNode(s.to),
            paid: Number(s.paid.toPrecision(10)),
            received: Number(s.received.toPrecision(10)),
            rate: s.rate ? Number(s.rate.toPrecision(10)) : null,
          })),
          cycle: candidate.pathNodes,
          shortPath: shortPath(candidate.pathNodes),
        });
      }

      continue;
    }

    const requiredSourceDrops = xrpToDropsCeil(startXrp);
    const destinationDrops = xrpToDropsFloor(evaluation.finalXrp);

    const requiredSourceXrp = Number(requiredSourceDrops) / 1_000_000;
    const destinationXrp = Number(destinationDrops) / 1_000_000;

    const estimatedProfitXrp = destinationXrp - requiredSourceXrp;
    const estimatedProfitPct = (estimatedProfitXrp / requiredSourceXrp) * 100;

    if (!Number.isFinite(estimatedProfitPct) || !Number.isFinite(estimatedProfitXrp)) {
      rejectedInvalid++;

      if (debugCycleRejections) {
        logger.debug("Cycle rejeté: profit non numérique après conversion drops", {
          topOfBookPct: Number(candidate.grossProfitPct.toFixed(6)),
          evaluation,
          requiredSourceDrops,
          destinationDrops,
          cycle: candidate.pathNodes,
        });
      }

      continue;
    }

    if (Number(destinationDrops) <= Number(requiredSourceDrops)) {
      rejectedRounding++;

      if (debugCycleRejections) {
        logger.debug("Cycle rejeté: après arrondi drops, le gain disparaît", {
          topOfBookPct: Number(candidate.grossProfitPct.toFixed(6)),
          beforeRoundingProfitPct: Number(evaluation.profitPct.toFixed(6)),
          beforeRoundingProfitXrp: Number(evaluation.profitXrp.toFixed(8)),
          requiredSourceDrops,
          destinationDrops,
          cycle: candidate.pathNodes,
          shortPath: shortPath(candidate.pathNodes),
        });
      }

      continue;
    }

    if (estimatedProfitPct < requiredPct) {
      rejectedRounding++;

      if (debugCycleRejections) {
        logger.debug("Cycle rejeté après arrondi drops", {
          topOfBookPct: Number(candidate.grossProfitPct.toFixed(6)),
          beforeRoundingProfitPct: Number(evaluation.profitPct.toFixed(6)),
          afterRoundingProfitPct: Number(estimatedProfitPct.toFixed(6)),
          requiredPct,
          requiredSourceDrops,
          destinationDrops,
          cycle: candidate.pathNodes,
          shortPath: shortPath(candidate.pathNodes),
        });
      }

      continue;
    }

    logger.info("Opportunité validée après profondeur réelle", {
      estimatedProfitPct: Number(estimatedProfitPct.toFixed(6)),
      estimatedProfitXrp: Number(estimatedProfitXrp.toFixed(6)),
      requiredSourceDrops,
      destinationDrops,
      cycle: shortPath(candidate.pathNodes),
    });

    return {
      requiredSourceDrops,
      destinationDrops,
      paths: evaluation.paths,
      estimatedProfitPct,
      estimatedProfitXrp,
      cyclePath: evaluation.pathNodes,
      source: "order_books",
    };
  }

  logger.info("Résumé rejet cycles candidats", {
    totalCandidates: candidates.length,
    rejectedDepth,
    rejectedRealProfit,
    rejectedRounding,
    rejectedInvalid,
    requiredPct,
    startXrp,
  });

  return null;
}

module.exports = {
  findOpportunityViaOrderBooks,
  buildDefaultNodes,
  evaluatePath,
  walkBookDepth,
  findCandidateCyclesFromXrp,
  recheckOrderBookOpportunity,
};