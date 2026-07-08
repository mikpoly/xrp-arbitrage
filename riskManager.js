const logger = require("./logger");
const config = require("./config");
const persistence = require("./persistence");

class RiskManager {
  constructor() {
    const loaded = persistence.load();
    this.totalPnlXrp = loaded.totalPnlXrp;
    this.dailyPnlXrp = loaded.dailyPnlXrp;
    this.dailyResetAt = loaded.dailyResetAt ? new Date(loaded.dailyResetAt) : this._nextMidnightUTC();
    this.consecutiveFailures = loaded.consecutiveFailures;
    this.breakerTrippedUntil = loaded.breakerTrippedUntil ? new Date(loaded.breakerTrippedUntil) : null;
    this.tradesExecuted = loaded.tradesExecuted;
    this.manualConfirmationsUsed = loaded.manualConfirmationsUsed || 0;
    this.tradeHistory = loaded.tradeHistory || [];
    this.errorHistory = loaded.errorHistory || [];
    this.startedAt = loaded.startedAt || new Date().toISOString();

    this.tradeInProgress = false;

    // Si l'état persisté vient d'un jour précédent, on remet le PnL journalier à zéro tout de suite.
    this._maybeResetDaily();
  }

  _nextMidnightUTC() {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  }

  _persist() {
    persistence.save({
      totalPnlXrp: this.totalPnlXrp,
      dailyPnlXrp: this.dailyPnlXrp,
      dailyResetAt: this.dailyResetAt.toISOString(),
      consecutiveFailures: this.consecutiveFailures,
      breakerTrippedUntil: this.breakerTrippedUntil ? this.breakerTrippedUntil.toISOString() : null,
      tradesExecuted: this.tradesExecuted,
      manualConfirmationsUsed: this.manualConfirmationsUsed,
      tradeHistory: this.tradeHistory,
      errorHistory: this.errorHistory,
      startedAt: this.startedAt,
    });
  }

  _maybeResetDaily() {
    if (new Date() >= this.dailyResetAt) {
      logger.info(`Reset journalier du compteur PnL (était: ${this.dailyPnlXrp.toFixed(4)} XRP)`);
      this.dailyPnlXrp = 0;
      this.dailyResetAt = this._nextMidnightUTC();
      this._persist();
    }
  }

  canTrade() {
    this._maybeResetDaily();

    if (this.tradeInProgress) {
      return { ok: false, reason: "Une transaction est déjà en cours (évite le chevauchement)." };
    }

    if (this.breakerTrippedUntil && new Date() < this.breakerTrippedUntil) {
      return { ok: false, reason: `Coupe-circuit actif jusqu'à ${this.breakerTrippedUntil.toISOString()} (trop d'échecs récents).` };
    }

    if (this.dailyPnlXrp <= -Math.abs(config.MAX_DAILY_LOSS_XRP)) {
      return { ok: false, reason: `Limite de perte journalière atteinte (${this.dailyPnlXrp.toFixed(4)} XRP). Bot en pause jusqu'à demain.` };
    }

    return { ok: true };
  }

  lock() {
    this.tradeInProgress = true;
  }

  unlock() {
    this.tradeInProgress = false;
  }

  recordSuccess(pnlXrp, hash) {
    this.consecutiveFailures = 0;
    this.dailyPnlXrp += pnlXrp;
    this.totalPnlXrp += pnlXrp;
    this.tradesExecuted += 1;
    this.tradeHistory.push({ timestamp: new Date().toISOString(), hash, result: "success", pnlXrp });
    this._persist();
    logger.trade(`Trade réussi. PnL: ${pnlXrp.toFixed(4)} XRP. Cumul du jour: ${this.dailyPnlXrp.toFixed(4)} XRP. Cumul total: ${this.totalPnlXrp.toFixed(4)} XRP`);
  }

  recordFailure(reason, hash) {
    this.consecutiveFailures++;
    this.errorHistory.push({ timestamp: new Date().toISOString(), message: reason, hash: hash || null });
    logger.warn(`Échec de trade (${this.consecutiveFailures}/${config.MAX_CONSECUTIVE_FAILURES})`, { reason });

    if (this.consecutiveFailures >= config.MAX_CONSECUTIVE_FAILURES) {
      this.breakerTrippedUntil = new Date(Date.now() + config.COOLDOWN_AFTER_BREAKER_MS);
      logger.error(`Coupe-circuit déclenché : ${this.consecutiveFailures} échecs consécutifs. Pause jusqu'à ${this.breakerTrippedUntil.toISOString()}.`);
      this.consecutiveFailures = 0;
    }
    this._persist();
  }

  recordManualConfirmationUsed() {
    this.manualConfirmationsUsed += 1;
    this._persist();
  }

  getSnapshot() {
    return {
      totalPnlXrp: this.totalPnlXrp,
      dailyPnlXrp: this.dailyPnlXrp,
      consecutiveFailures: this.consecutiveFailures,
      breakerTrippedUntil: this.breakerTrippedUntil,
      tradesExecuted: this.tradesExecuted,
      manualConfirmationsUsed: this.manualConfirmationsUsed,
      tradeHistory: this.tradeHistory.slice(-50),
      errorHistory: this.errorHistory.slice(-50),
      startedAt: this.startedAt,
      tradeInProgress: this.tradeInProgress,
    };
  }
}

module.exports = RiskManager;
