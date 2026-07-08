const logger = require("./logger");
const { classify } = require("./txResultCodes");

const LEDGER_BUFFER = 6;
const POLL_INTERVAL_MS = 1000;
const RECONNECT_WAIT_MS = 15000;
const SUBMIT_ATTEMPTS = 2;

async function prepareWithStrictLedgerBound(client, xrplClient, tx) {
  const currentLedger = await xrplClient.getCurrentLedgerIndex();
  const lastLedgerSequence = currentLedger + LEDGER_BUFFER;

  const prepared = await client.autofill({ ...tx, LastLedgerSequence: lastLedgerSequence });
  prepared.LastLedgerSequence = lastLedgerSequence;

  return { prepared, lastLedgerSequence, submittedAtLedger: currentLedger };
}

async function getLiveClient(fallbackClient, xrplClient, waitMs = RECONNECT_WAIT_MS) {
  if (xrplClient && typeof xrplClient.isReady === "function" && !xrplClient.isReady()) {
    if (typeof xrplClient.waitUntilReady === "function") {
      await xrplClient.waitUntilReady(waitMs);
    }
  }

  if (xrplClient && typeof xrplClient.getClient === "function") {
    try {
      return xrplClient.getClient();
    } catch (_) {}
  }

  return fallbackClient;
}

async function safeCurrentLedger(client, xrplClient) {
  try {
    const liveClient = await getLiveClient(client, xrplClient);
    const ledgerResponse = await liveClient.request({ command: "ledger_current" });
    return ledgerResponse.result.ledger_current_index;
  } catch (_) {
    return null;
  }
}

async function readValidatedTx(client, xrplClient, hash) {
  const liveClient = await getLiveClient(client, xrplClient);
  const txResponse = await liveClient.request({ command: "tx", transaction: hash });

  if (!txResponse.result.validated) return null;

  const code = txResponse.result.meta.TransactionResult;
  const info = classify(code);

  return {
    hash,
    validated: true,
    finalResult: code,
    classification: info,
    txResponse: txResponse.result,
  };
}

async function submitReliable(client, xrplClient, signedTx, lastLedgerSequence) {
  const hash = signedTx.hash;

  let submitResponse = null;
  let lastSubmitError = null;

  for (let attempt = 1; attempt <= SUBMIT_ATTEMPTS; attempt++) {
    try {
      const liveClient = await getLiveClient(client, xrplClient);
      submitResponse = await liveClient.submit(signedTx.tx_blob);
      break;
    } catch (err) {
      lastSubmitError = err;

      logger.warn("Erreur réseau lors de la soumission initiale, tentative de récupération", {
        hash,
        attempt,
        maxAttempts: SUBMIT_ATTEMPTS,
        error: err.message,
      });

      try {
        const validated = await readValidatedTx(client, xrplClient, hash);
        if (validated) {
          logger.trade("Transaction retrouvée validée après coupure réseau", {
            hash,
            code: validated.finalResult,
            category: validated.classification.category,
          });
          return validated;
        }
      } catch (_) {}

      const currentLedgerIndex = await safeCurrentLedger(client, xrplClient);
      if (currentLedgerIndex !== null && currentLedgerIndex > lastLedgerSequence) {
        return await handleExpiration(client, xrplClient, hash, lastLedgerSequence);
      }

      if (attempt < SUBMIT_ATTEMPTS) {
        await sleep(POLL_INTERVAL_MS);
      }
    }
  }

  if (!submitResponse) {
    logger.error("Erreur réseau lors de la soumission initiale", {
      hash,
      error: lastSubmitError ? lastSubmitError.message : "inconnue",
    });
    throw lastSubmitError || new Error("Soumission impossible: erreur inconnue");
  }

  const preliminaryCode = submitResponse.result.engine_result;
  const preliminaryInfo = classify(preliminaryCode);

  logger.trade("Résultat préliminaire de soumission", {
    hash,
    preliminaryCode,
    category: preliminaryInfo.category,
    message: preliminaryInfo.message,
  });

  if (preliminaryCode === "tefALREADY") {
    return await pollForValidation(client, xrplClient, hash, lastLedgerSequence);
  }

  if (preliminaryInfo.category === "tem" || preliminaryInfo.category === "tef") {
    return {
      hash,
      validated: false,
      finalResult: preliminaryCode,
      classification: preliminaryInfo,
    };
  }

  return await pollForValidation(client, xrplClient, hash, lastLedgerSequence);
}

async function pollForValidation(client, xrplClient, hash, lastLedgerSequence) {
  while (true) {
    let liveClient;

    try {
      liveClient = await getLiveClient(client, xrplClient);
    } catch (err) {
      logger.warn("Client XRPL non disponible pendant le polling, nouvelle tentative...", { error: err.message });
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    let ledgerResponse;
    try {
      ledgerResponse = await liveClient.request({ command: "ledger_current" });
    } catch (err) {
      logger.warn("Erreur réseau pendant le polling (ledger_current), nouvelle tentative...", { error: err.message });
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const currentLedgerIndex = ledgerResponse.result.ledger_current_index;

    try {
      const validated = await readValidatedTx(liveClient, xrplClient, hash);
      if (validated) {
        logger.trade("Transaction validée définitivement", {
          hash,
          code: validated.finalResult,
          category: validated.classification.category,
          message: validated.classification.message,
        });
        return validated;
      }
    } catch (err) {
      const notFound = err.data && err.data.error === "txnNotFound";
      if (!notFound) {
        logger.warn("Erreur réseau pendant le polling (tx), nouvelle tentative...", { error: err.message });
      }
    }

    if (currentLedgerIndex > lastLedgerSequence) {
      return await handleExpiration(liveClient, xrplClient, hash, lastLedgerSequence);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

async function handleExpiration(client, xrplClient, hash, lastLedgerSequence) {
  try {
    const validated = await readValidatedTx(client, xrplClient, hash);
    if (validated) {
      logger.trade("Transaction validée juste avant expiration (détectée au dernier check)", {
        hash,
        code: validated.finalResult,
      });
      return validated;
    }
  } catch (_) {}

  logger.warn("Transaction expirée sans validation (LastLedgerSequence dépassé). Aucun fonds principal déplacé, frais réseau non consommés si la transaction n'a jamais été incluse.", {
    hash,
    lastLedgerSequence,
  });

  return {
    hash,
    validated: false,
    finalResult: "LOCAL_EXPIRED",
    classification: {
      code: "LOCAL_EXPIRED",
      category: "expired",
      definitive: true,
      retryable: true,
      message: "Transaction jamais incluse dans un ledger avant expiration. Sûr de retenter avec une nouvelle transaction.",
    },
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { prepareWithStrictLedgerBound, submitReliable, LEDGER_BUFFER };