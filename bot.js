const config = require("./config");
const logger = require("./logger");
const XrplClient = require("./xrplClient");
const RiskManager = require("./riskManager");
const { loadWallet } = require("./wallet");
const { findOpportunity, recheckOpportunity, executeOpportunity } = require("./arbitrage");
const { startDashboard } = require("./dashboard/server");
const { buildWatchlist } = require("./tokenDiscovery");

let shuttingDown = false;

let lastScanInfo = {
  timestamp: null,
  opportunity: null,
  availableXrp: null,
  skippedReason: "Démarrage du bot...",
};

let lastBalanceBreakdown = null;
let currentWatchlist = null;

function serializeOpportunity(opportunity) {
  if (!opportunity) return null;

  return {
    profitPct: opportunity.estimatedProfitPct,
    profitXrp: opportunity.estimatedProfitXrp,
    source: opportunity.source || "safe_payment",
    transactionKind: opportunity.transactionKind || null,
    targetNode: opportunity.targetNode || null,
    sourceNode: opportunity.sourceNode || null,
    cyclePath: opportunity.cyclePath || null,
    amount: opportunity.amount || null,
    sendMax: opportunity.sendMax || null,
    executable: opportunity.executable !== false,
    executionBlockedReason: opportunity.executionBlockedReason || null,
  };
}

function calculateRiskPnlXrp(opportunity, feeDrops) {
  const feeXrp = Number(feeDrops || 0) / 1_000_000;

  if (!opportunity) return -feeXrp;

  if (opportunity.transactionKind === "xrp_to_token") {
    return -feeXrp;
  }

  const gross =
    opportunity.realizedPnlXrp !== undefined
      ? Number(opportunity.realizedPnlXrp)
      : Number(opportunity.estimatedProfitXrp || 0);

  if (!Number.isFinite(gross)) return -feeXrp;

  return gross - feeXrp;
}

function isDiagnosticOnlyOpportunity(opportunity) {
  if (!opportunity) return false;

  return (
    opportunity.executable === false ||
    opportunity.source === "order_books_diagnostic" ||
    opportunity.transactionKind === "diagnostic_orderbook_cycle"
  );
}

async function runCycle(xrplClient, wallet, riskManager) {
  if (!xrplClient.isReady()) {
    logger.info("Cycle ignoré: client XRPL non prêt ou reconnexion en cours.");

    lastScanInfo = {
      timestamp: new Date().toISOString(),
      opportunity: null,
      skippedReason: "Client XRPL non prêt ou reconnexion en cours",
    };

    return;
  }

  const gate = riskManager.canTrade();

  if (!gate.ok) {
    logger.info(`Cycle ignoré: ${gate.reason}`);

    lastScanInfo = {
      timestamp: new Date().toISOString(),
      opportunity: null,
      skippedReason: gate.reason,
    };

    return;
  }

  let client;

  try {
    client = xrplClient.getClient();
  } catch (err) {
    logger.info("Cycle ignoré: client XRPL indisponible", {
      error: err.message,
    });

    lastScanInfo = {
      timestamp: new Date().toISOString(),
      opportunity: null,
      skippedReason: "Client XRPL indisponible",
    };

    return;
  }

  let balance;

  try {
    balance = await xrplClient.getBalanceBreakdown(wallet.address);
    lastBalanceBreakdown = balance;
  } catch (err) {
    logger.error("Impossible de calculer le solde disponible", {
      error: err.message,
    });

    lastScanInfo = {
      timestamp: new Date().toISOString(),
      opportunity: null,
      skippedReason: "Impossible de calculer le solde disponible",
    };

    return;
  }

  const availableXrp = balance.availableXrp;

  if (availableXrp <= 0) {
    logger.warn(
      `Solde disponible insuffisant après réserve (${availableXrp.toFixed(2)} XRP). ` +
        `Solde total: ${balance.totalXrp.toFixed(2)} XRP, ` +
        `réserve protocole: ${balance.protocolReserveXrp.toFixed(2)} XRP, ` +
        `marge de sécurité: ${balance.safetyBufferXrp.toFixed(2)} XRP.`
    );

    lastScanInfo = {
      timestamp: new Date().toISOString(),
      opportunity: null,
      availableXrp,
      skippedReason: "Solde disponible insuffisant",
    };

    return;
  }

  const tradeAmountXrp = Math.min(config.MAX_TRADE_XRP, availableXrp);

  const opportunityParams = {
    startXrp: tradeAmountXrp,
    minProfitPct: config.MIN_PROFIT_PCT,
    slippageBufferPct: config.SLIPPAGE_BUFFER_PCT,
    mainnetIssuers: config.MAINNET_ISSUERS,
    extraTokens: config.EXTRA_TOKENS,
    nodes: currentWatchlist,
  };

  let opportunity;

  try {
    opportunity = await findOpportunity(client, wallet, opportunityParams);
  } catch (err) {
    logger.error("Erreur pendant la recherche d'opportunité", {
      error: err.message,
    });

    lastScanInfo = {
      timestamp: new Date().toISOString(),
      opportunity: null,
      availableXrp,
      tradeAmountXrp,
      skippedReason: "Erreur pendant la recherche d'opportunité",
    };

    return;
  }

  lastScanInfo = {
    timestamp: new Date().toISOString(),
    opportunity: serializeOpportunity(opportunity),
    availableXrp,
    tradeAmountXrp,
    skippedReason: opportunity ? null : "Aucune opportunité exécutable rentable",
  };

  if (!opportunity) {
    logger.info(`Aucune opportunité rentable exécutable (montant testé: ${tradeAmountXrp.toFixed(4)} XRP)`);
    return;
  }

  /*
   * IMPORTANT :
   * Les cycles order-book XRP -> token -> ... -> XRP peuvent être rentables en théorie,
   * mais ils ne sont pas exécutables avec une seule Payment XRPL si Amount et SendMax
   * sont tous les deux en XRP.
   *
   * Avant, le bot affichait "Opportunité détectée", puis disait qu'il n'envoyait rien.
   * C'était confus.
   *
   * Maintenant, on les affiche clairement comme DIAGNOSTIC NON TRADABLE.
   */
  if (isDiagnosticOnlyOpportunity(opportunity)) {
    logger.info(
      `Cycle order-book diagnostic trouvé: +${opportunity.estimatedProfitPct.toFixed(3)}% ` +
        `(≈ avantage théorique ${opportunity.estimatedProfitXrp.toFixed(6)} XRP), non envoyé.`,
      {
        source: opportunity.source,
        transactionKind: opportunity.transactionKind,
        executable: false,
        cyclePath: opportunity.cyclePath || null,
        reason:
          opportunity.executionBlockedReason ||
          "Cycle XRP->...->XRP non exécutable comme Payment XRPL atomique.",
      }
    );

    lastScanInfo = {
      ...lastScanInfo,
      skippedReason:
        opportunity.executionBlockedReason ||
        "Cycle order-book diagnostic non exécutable, aucune transaction envoyée",
    };

    return;
  }

  logger.info(
    `Opportunité EXÉCUTABLE détectée: +${opportunity.estimatedProfitPct.toFixed(3)}% ` +
      `(≈ avantage estimé ${opportunity.estimatedProfitXrp.toFixed(6)} XRP)`,
    {
      source: opportunity.source,
      transactionKind: opportunity.transactionKind,
      targetNode: opportunity.targetNode || null,
      sourceNode: opportunity.sourceNode || null,
      executable: true,
    }
  );

  if (config.DRY_RUN) {
    logger.info("DRY_RUN actif: aucune transaction envoyée.");

    lastScanInfo = {
      ...lastScanInfo,
      skippedReason: "DRY_RUN actif",
    };

    return;
  }

  if (!xrplClient.isReady()) {
    logger.info("Opportunité ignorée: client XRPL en reconnexion avant revérification finale.");

    lastScanInfo = {
      ...lastScanInfo,
      skippedReason: "Client XRPL en reconnexion avant revérification finale",
    };

    return;
  }

  try {
    client = xrplClient.getClient();
  } catch (err) {
    logger.info("Opportunité ignorée: impossible de récupérer un client XRPL connecté avant revérification finale", {
      error: err.message,
    });

    lastScanInfo = {
      ...lastScanInfo,
      skippedReason: "Client XRPL indisponible avant revérification finale",
    };

    return;
  }

  let finalCheck;

  try {
    finalCheck = await recheckOpportunity(client, wallet, opportunity, opportunityParams);
  } catch (err) {
    logger.warn("Re-vérification finale impossible, on n'exécute pas par prudence", {
      error: err.message,
    });

    lastScanInfo = {
      ...lastScanInfo,
      skippedReason: "Re-vérification finale impossible",
    };

    return;
  }

  if (!finalCheck) {
    logger.info("Opportunité disparue entre la détection et l'exécution. Abandon.");

    lastScanInfo = {
      ...lastScanInfo,
      skippedReason: "Opportunité disparue avant exécution",
    };

    return;
  }

  if (isDiagnosticOnlyOpportunity(finalCheck)) {
    logger.info("Re-vérification finale: opportunité devenue diagnostic/non exécutable. Aucune transaction envoyée.", {
      source: finalCheck.source,
      transactionKind: finalCheck.transactionKind,
      reason:
        finalCheck.executionBlockedReason ||
        "Opportunité non exécutable après revérification finale.",
    });

    lastScanInfo = {
      ...lastScanInfo,
      opportunity: serializeOpportunity(finalCheck),
      skippedReason:
        finalCheck.executionBlockedReason ||
        "Opportunité non exécutable après revérification finale",
    };

    return;
  }

  if (!xrplClient.isReady()) {
    logger.info("Opportunité ignorée: client XRPL en reconnexion avant soumission.");

    lastScanInfo = {
      ...lastScanInfo,
      opportunity: serializeOpportunity(finalCheck),
      skippedReason: "Client XRPL en reconnexion avant soumission",
    };

    return;
  }

  try {
    client = xrplClient.getClient();
  } catch (err) {
    logger.info("Opportunité ignorée: client XRPL indisponible avant soumission", {
      error: err.message,
    });

    lastScanInfo = {
      ...lastScanInfo,
      opportunity: serializeOpportunity(finalCheck),
      skippedReason: "Client XRPL indisponible avant soumission",
    };

    return;
  }

  logger.trade("Mode automatique: exécution Safe Payment sans confirmation manuelle", {
    amountXrpReference: tradeAmountXrp,
    estimatedProfitPct: finalCheck.estimatedProfitPct,
    estimatedProfitXrp: finalCheck.estimatedProfitXrp,
    source: finalCheck.source || "safe_payment",
    transactionKind: finalCheck.transactionKind || null,
    targetNode: finalCheck.targetNode || null,
    sourceNode: finalCheck.sourceNode || null,
    amount: finalCheck.amount || null,
    sendMax: finalCheck.sendMax || null,
  });

  riskManager.lock();

  try {
    const feeDrops = await xrplClient.getDynamicFeeDrops();
    const outcome = await executeOpportunity(client, xrplClient, wallet, finalCheck, feeDrops);

    const riskPnlXrp = calculateRiskPnlXrp(finalCheck, feeDrops);

    logger.trade("PnL enregistré après frais", {
      transactionKind: finalCheck.transactionKind,
      grossEstimatedProfitXrp: finalCheck.estimatedProfitXrp,
      feeXrp: Number(feeDrops) / 1_000_000,
      recordedPnlXrp: riskPnlXrp,
      note:
        finalCheck.transactionKind === "xrp_to_token"
          ? "Achat token: aucun profit XRP réalisé, seul le fee est compté."
          : "Sortie token->XRP: PnL estimé net des frais.",
    });

    riskManager.recordSuccess(riskPnlXrp, outcome.hash);

    lastScanInfo = {
      timestamp: new Date().toISOString(),
      opportunity: {
        ...serializeOpportunity(finalCheck),
        hash: outcome.hash,
        result: outcome.finalResult,
      },
      availableXrp,
      tradeAmountXrp,
      skippedReason: null,
    };
  } catch (err) {
    if (err.doNotCountAsTradeFailure) {
      logger.warn(err.message, {
        code: err.code,
        source: err.opportunity ? err.opportunity.source : null,
        transactionKind: err.opportunity ? err.opportunity.transactionKind : null,
        estimatedProfitPct: err.opportunity ? err.opportunity.estimatedProfitPct : null,
        estimatedProfitXrp: err.opportunity ? err.opportunity.estimatedProfitXrp : null,
      });

      lastScanInfo = {
        timestamp: new Date().toISOString(),
        opportunity: {
          profitPct: err.opportunity ? err.opportunity.estimatedProfitPct : null,
          profitXrp: err.opportunity ? err.opportunity.estimatedProfitXrp : null,
          source: err.opportunity ? err.opportunity.source : null,
          transactionKind: err.opportunity ? err.opportunity.transactionKind : null,
        },
        availableXrp,
        tradeAmountXrp,
        skippedReason: err.code || "Opportunité non exécutable",
      };
    } else {
      riskManager.recordFailure(err.message, err.outcome?.hash);

      lastScanInfo = {
        timestamp: new Date().toISOString(),
        opportunity: {
          ...serializeOpportunity(finalCheck),
          hash: err.outcome ? err.outcome.hash : null,
          result: err.outcome ? err.outcome.finalResult : null,
        },
        availableXrp,
        tradeAmountXrp,
        skippedReason: err.message,
      };
    }
  } finally {
    riskManager.unlock();
  }
}

async function main() {
  logger.info("=== Bot d'arbitrage XRPL Safe Payment (production) ===");

  logger.info(
    `Réseau: ${config.NETWORK} | DRY_RUN: ${config.DRY_RUN} | ` +
      `Max/trade: ${config.MAX_TRADE_XRP} XRP | ` +
      `Mode automatique: true | ` +
      `Confirmations manuelles: désactivées`
  );

  logger.warn(
    "RAPPEL: aucune garantie de profit. Le bot exécute seulement des Payment XRPL sûrs " +
      "(XRP -> token ou token -> XRP). Les cycles XRP -> ... -> XRP sont affichés en diagnostic mais ne sont pas envoyés."
  );

  const xrplClient = new XrplClient();
  await xrplClient.connect();

  const wallet = await loadWallet(xrplClient.getClient());
  const riskManager = new RiskManager();

  const initialBalance = await xrplClient.getBalanceBreakdown(wallet.address);
  lastBalanceBreakdown = initialBalance;

  logger.info(
    `Solde total: ${initialBalance.totalXrp.toFixed(4)} XRP | ` +
      `Réserve protocole: ${initialBalance.protocolReserveXrp.toFixed(4)} XRP | ` +
      `Marge de sécurité: ${initialBalance.safetyBufferXrp.toFixed(4)} XRP | ` +
      `Disponible pour trading: ${initialBalance.availableXrp.toFixed(4)} XRP`
  );

  let dashboardServer = null;
  let isScanning = false;
  let watchlistRefreshInProgress = false;
  let pendingWatchlistRefresh = false;
  let pendingScanTrigger = null;
  let lastScanStartedAt = 0;
  let lastScanFinishedAt = 0;
  let lastBusyScanLogAt = 0;
  let lastLedgerTriggerAt = 0;
  let queuedScanTimer = null;

  const MIN_SCAN_INTERVAL_MS = Math.max(
    config.SCAN_INTERVAL_MS || 30000,
    config.MIN_SCAN_INTERVAL_MS || 30000
  );

  const LEDGER_TRIGGER_DEBOUNCE_MS = Math.max(
    1000,
    config.LEDGER_TRIGGER_DEBOUNCE_MS || MIN_SCAN_INTERVAL_MS
  );

  const BUSY_SCAN_LOG_THROTTLE_MS = Math.max(
    1000,
    config.BUSY_SCAN_LOG_THROTTLE_MS || 30000
  );

  function scheduleQueuedScan(trigger) {
    if (shuttingDown || queuedScanTimer) return;

    const elapsedSinceFinish = Date.now() - lastScanFinishedAt;
    const delay = Math.max(0, MIN_SCAN_INTERVAL_MS - elapsedSinceFinish);

    queuedScanTimer = setTimeout(() => {
      queuedScanTimer = null;

      loop(trigger).catch((err) => {
        logger.error("Erreur inattendue dans le scan différé", {
          error: err.message,
          stack: err.stack,
        });
      });
    }, delay);
  }

  async function refreshWatchlist(reason = "timer") {
    if (watchlistRefreshInProgress) {
      pendingWatchlistRefresh = true;

      logger.debug("Rafraîchissement watchlist ignoré: déjà en cours", {
        reason,
      });

      return;
    }

    if (isScanning) {
      pendingWatchlistRefresh = true;

      logger.debug("Rafraîchissement watchlist reporté: scan en cours", {
        reason,
      });

      return;
    }

    if (!xrplClient.isReady()) {
      logger.info("Rafraîchissement watchlist ignoré: client XRPL non prêt.", {
        reason,
        reconnecting: xrplClient.isReconnecting(),
      });

      return;
    }

    watchlistRefreshInProgress = true;

    lastScanInfo = {
      timestamp: new Date().toISOString(),
      opportunity: null,
      availableXrp: lastBalanceBreakdown ? lastBalanceBreakdown.availableXrp : null,
      skippedReason: "Construction / rafraîchissement watchlist en cours",
    };

    try {
      const wl = await buildWatchlist(xrplClient.getClient(), {
        maxTokens: config.DISCOVERY_MAX_TOKENS,
        ledgersToScan: config.DISCOVERY_LEDGERS_TO_SCAN,
        minActivity: config.DISCOVERY_MIN_ACTIVITY,
        minOffers: config.DISCOVERY_MIN_OFFERS,
        requireBothSides: config.DISCOVERY_REQUIRE_BOTH_XRP_SIDES,
      });

      if (wl.length > 1) {
        currentWatchlist = wl;

        logger.info(`Watchlist active: ${wl.length - 1} tokens + XRP`, {
          tokens: wl.slice(1).map((t) => t.slice(0, 30)),
        });

        lastScanInfo = {
          timestamp: new Date().toISOString(),
          opportunity: null,
          availableXrp: lastBalanceBreakdown ? lastBalanceBreakdown.availableXrp : null,
          skippedReason: "Watchlist prête, attente du prochain scan",
        };
      } else {
        logger.warn("Découverte: aucun token liquide trouvé, on garde la watchlist précédente.");

        lastScanInfo = {
          timestamp: new Date().toISOString(),
          opportunity: null,
          availableXrp: lastBalanceBreakdown ? lastBalanceBreakdown.availableXrp : null,
          skippedReason: "Aucun token liquide trouvé, watchlist précédente conservée",
        };
      }
    } catch (err) {
      logger.error("Échec du rafraîchissement de la watchlist", {
        error: err.message,
      });

      lastScanInfo = {
        timestamp: new Date().toISOString(),
        opportunity: null,
        availableXrp: lastBalanceBreakdown ? lastBalanceBreakdown.availableXrp : null,
        skippedReason: "Échec du rafraîchissement de la watchlist",
      };
    } finally {
      watchlistRefreshInProgress = false;

      if (pendingWatchlistRefresh && !shuttingDown) {
        pendingWatchlistRefresh = false;
        setTimeout(() => refreshWatchlist("queued"), Math.max(5000, MIN_SCAN_INTERVAL_MS));
      }
    }
  }

  if (config.DASHBOARD_ENABLED) {
    dashboardServer = startDashboard({
      port: config.DASHBOARD_PORT,
      getState: () => ({
        network: config.NETWORK,
        dryRun: config.DRY_RUN,
        walletAddress: wallet.address,
        maxTradeXrp: config.MAX_TRADE_XRP,
        minProfitPct: config.MIN_PROFIT_PCT,
        slippageBufferPct: config.SLIPPAGE_BUFFER_PCT,
        balance: lastBalanceBreakdown,
        watchlist: currentWatchlist,
        lastScan: lastScanInfo,
        xrplReady: xrplClient.isReady(),
        xrplReconnecting: xrplClient.isReconnecting(),
        risk: riskManager.getSnapshot(),
        logs: logger.getRecentLogs(150),
      }),
    });
  }

  await refreshWatchlist("startup");

  setInterval(() => {
    if (!shuttingDown) refreshWatchlist("timer");
  }, config.DISCOVERY_REFRESH_MS);

  async function loop(trigger = "timer") {
    if (shuttingDown) return;

    const now = Date.now();

    if (isScanning) {
      pendingScanTrigger = trigger;

      if (now - lastBusyScanLogAt >= BUSY_SCAN_LOG_THROTTLE_MS) {
        lastBusyScanLogAt = now;

        logger.debug("Scan reporté: scan déjà en cours", {
          trigger,
          pendingScanTrigger,
          scanAgeMs: lastScanStartedAt ? now - lastScanStartedAt : null,
        });
      }

      return;
    }

    if (watchlistRefreshInProgress) {
      pendingScanTrigger = trigger;

      logger.debug("Scan reporté: watchlist en cours de construction", {
        trigger,
      });

      return;
    }

    if (now - lastScanFinishedAt < MIN_SCAN_INTERVAL_MS) {
      pendingScanTrigger = trigger;

      logger.debug("Scan reporté: intervalle minimum non atteint", {
        trigger,
        remainingMs: MIN_SCAN_INTERVAL_MS - (now - lastScanFinishedAt),
      });

      scheduleQueuedScan(`${trigger}:queued`);
      return;
    }

    if (!xrplClient.isReady()) {
      logger.info("Scan ignoré: client XRPL non prêt.", {
        trigger,
        reconnecting: xrplClient.isReconnecting(),
      });

      lastScanInfo = {
        timestamp: new Date().toISOString(),
        opportunity: null,
        skippedReason: "Client XRPL non prêt",
      };

      return;
    }

    isScanning = true;
    lastScanStartedAt = now;

    try {
      logger.debug("Démarrage scan", {
        trigger,
      });

      await runCycle(xrplClient, wallet, riskManager);
    } catch (err) {
      logger.error("Erreur inattendue dans le cycle principal", {
        error: err.message,
        stack: err.stack,
      });

      lastScanInfo = {
        timestamp: new Date().toISOString(),
        opportunity: null,
        skippedReason: `Erreur inattendue dans le cycle principal: ${err.message}`,
      };
    } finally {
      isScanning = false;
      lastScanFinishedAt = Date.now();

      if (pendingWatchlistRefresh && !shuttingDown) {
        pendingWatchlistRefresh = false;

        setTimeout(
          () => refreshWatchlist("after_scan"),
          Math.max(5000, Math.floor(MIN_SCAN_INTERVAL_MS / 2))
        );
      }

      if (pendingScanTrigger && !shuttingDown) {
        const queuedTrigger = pendingScanTrigger;
        pendingScanTrigger = null;
        scheduleQueuedScan(`${queuedTrigger}:after_scan`);
      }
    }
  }

  try {
    await xrplClient.subscribeToLedgerClose(() => {
      const now = Date.now();

      if (now - lastLedgerTriggerAt < LEDGER_TRIGGER_DEBOUNCE_MS) {
        return;
      }

      lastLedgerTriggerAt = now;

      loop("ledger").catch((err) => {
        logger.error("Erreur inattendue dans le scan ledger", {
          error: err.message,
          stack: err.stack,
        });
      });
    });
  } catch (err) {
    logger.warn("Abonnement au flux de ledger impossible, on reste sur le minuteur classique.", {
      error: err.message,
    });
  }

  function safetyNetLoop() {
    if (shuttingDown) return;

    loop("timer").catch((err) => {
      logger.error("Erreur inattendue dans le scan timer", {
        error: err.message,
        stack: err.stack,
      });
    });

    setTimeout(safetyNetLoop, MIN_SCAN_INTERVAL_MS);
  }

  safetyNetLoop();

  async function shutdown(signal) {
    if (shuttingDown) return;

    shuttingDown = true;

    logger.info(`Signal ${signal} reçu, arrêt propre en cours...`);

    try {
      if (queuedScanTimer) clearTimeout(queuedScanTimer);
    } catch (_) {}

    try {
      if (dashboardServer) dashboardServer.close();
    } catch (_) {}

    try {
      if (xrplClient.isReady()) {
        await xrplClient.getClient().disconnect();
      }
    } catch (_) {}

    logger.info("Arrêt terminé.");
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    logger.error("Promesse rejetée non gérée", {
      reason: reason?.message || reason,
    });
  });
}

main().catch((err) => {
  logger.error("Erreur fatale au démarrage", {
    error: err.message,
    stack: err.stack,
  });

  process.exit(1);
});