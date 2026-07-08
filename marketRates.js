const logger = require("./logger");
const config = require("./config");

function nodeKey(currencyObj) {
  if (currencyObj.currency === "XRP") return "XRP";
  return `${currencyObj.currency}.${currencyObj.issuer}`;
}

function nodeToCurrencyObj(key) {
  if (key === "XRP") return { currency: "XRP" };

  const idx = key.indexOf(".");
  if (idx === -1) {
    throw new Error(`Node invalide: "${key}"`);
  }

  return {
    currency: key.slice(0, idx),
    issuer: key.slice(idx + 1),
  };
}

function amountValue(amount) {
  if (typeof amount === "string") return Number(amount) / 1_000_000;
  return Number(amount.value);
}

async function fetchTopOfBookRate(client, getCurrency, payCurrency) {
  try {
    const response = await client.request({
      command: "book_offers",
      taker_gets: getCurrency,
      taker_pays: payCurrency,
      limit: 1,
    });

    const offers = response.result.offers || [];
    if (offers.length === 0) return null;

    const gets = amountValue(offers[0].TakerGets);
    const pays = amountValue(offers[0].TakerPays);

    if (!Number.isFinite(gets) || !Number.isFinite(pays)) return null;
    if (gets <= 0 || pays <= 0) return null;

    return gets / pays;
  } catch (_) {
    return null;
  }
}

async function runWithConcurrency(tasks, concurrency) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      try {
        results[i] = await tasks[i]();
      } catch (err) {
        results[i] = null;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

function uniqueNodes(nodes) {
  return [...new Set((nodes || []).filter(Boolean))];
}

async function fetchAllPairsRates(client, nodes, options = {}) {
  const concurrency = options.concurrency || config.RATE_SCAN_CONCURRENCY;
  const cleanNodes = uniqueNodes(nodes);
  const rateMap = new Map();

  const tasks = [];

  for (const from of cleanNodes) {
    for (const to of cleanNodes) {
      if (from === to) continue;

      tasks.push(async () => {
        const fromObj = nodeToCurrencyObj(from);
        const toObj = nodeToCurrencyObj(to);

        // from => to signifie : je paie FROM et je reçois TO.
        const rate = await fetchTopOfBookRate(client, toObj, fromObj);

        if (rate !== null && rate > 0) {
          rateMap.set(`${from}=>${to}`, rate);
        }
      });
    }
  }

  await runWithConcurrency(tasks, concurrency);

  logger.info("Scan taux terminé", {
    mode: "ALL_PAIRS",
    nodes: cleanNodes.length,
    possibleDirectedPairs: cleanNodes.length * (cleanNodes.length - 1),
    ratesFound: rateMap.size,
  });

  return rateMap;
}

async function fetchHubAndSpokeRates(client, nodes, options = {}) {
  const concurrency = options.concurrency || config.RATE_SCAN_CONCURRENCY;
  const rateMap = new Map();
  const tokens = uniqueNodes(nodes).filter((n) => n !== "XRP");

  const phase1Tasks = [];

  for (const token of tokens) {
    phase1Tasks.push(async () => {
      const rate = await fetchTopOfBookRate(client, nodeToCurrencyObj(token), nodeToCurrencyObj("XRP"));
      if (rate !== null) rateMap.set(`XRP=>${token}`, rate);
    });

    phase1Tasks.push(async () => {
      const rate = await fetchTopOfBookRate(client, nodeToCurrencyObj("XRP"), nodeToCurrencyObj(token));
      if (rate !== null) rateMap.set(`${token}=>XRP`, rate);
    });
  }

  await runWithConcurrency(phase1Tasks, concurrency);

  const liquidTokens = tokens.filter(
    (t) => rateMap.has(`XRP=>${t}`) && rateMap.has(`${t}=>XRP`)
  );

  const phase2Tasks = [];

  for (const from of liquidTokens) {
    for (const to of liquidTokens) {
      if (from === to) continue;

      phase2Tasks.push(async () => {
        const rate = await fetchTopOfBookRate(client, nodeToCurrencyObj(to), nodeToCurrencyObj(from));
        if (rate !== null) rateMap.set(`${from}=>${to}`, rate);
      });
    }
  }

  await runWithConcurrency(phase2Tasks, concurrency);

  logger.info("Scan taux terminé", {
    mode: "HUB_AND_SPOKE",
    tokens: tokens.length,
    liquidTokens: liquidTokens.length,
    ratesFound: rateMap.size,
  });

  return rateMap;
}

async function fetchAllRates(client, nodes, options = {}) {
  const scanAllPairs =
    options.scanAllPairs !== undefined ? options.scanAllPairs : config.RATE_SCAN_ALL_PAIRS;

  if (scanAllPairs) {
    return fetchAllPairsRates(client, nodes, options);
  }

  return fetchHubAndSpokeRates(client, nodes, options);
}

module.exports = {
  nodeKey,
  nodeToCurrencyObj,
  fetchAllRates,
  fetchTopOfBookRate,
  amountValue,
  runWithConcurrency,
};