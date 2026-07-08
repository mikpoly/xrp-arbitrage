const xrpl = require("xrpl");
const logger = require("./logger");
const config = require("./config");

class XrplClient {
  constructor() {
    this.client = null;
    this.currentUrlIndex = 0;

    this.reconnecting = false;
    this.reconnectPromise = null;

    this.ledgerCallbacks = new Set();
    this.subscribedToLedger = false;

    // Identifiant de génération pour ignorer les événements venant d'anciens clients.
    this.clientGeneration = 0;
  }

  _isClientConnected(client) {
    return !!client && typeof client.isConnected === "function" && client.isConnected();
  }

  isReady() {
    return this._isClientConnected(this.client) && !this.reconnecting;
  }

  isReconnecting() {
    return this.reconnecting;
  }

  getClient() {
    if (!this._isClientConnected(this.client)) {
      throw new Error("Client XRPL non connecté.");
    }

    return this.client;
  }

  async waitUntilReady(timeoutMs = 15000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (this.isReady()) return true;
      await sleep(250);
    }

    return false;
  }

  _isPermissionNoise(errorCode, errorMessage) {
    const code = String(errorCode || "").toLowerCase();
    const message = String(errorMessage || "").toLowerCase();

    return (
      code === "nopermission" ||
      message.includes("no permission") ||
      message.includes("permission")
    );
  }

  _attachHandlers(client, generation) {
    client.on("disconnected", (code) => {
      // Très important :
      // si l'événement vient d'un ancien client remplacé, on l'ignore.
      if (generation !== this.clientGeneration || client !== this.client) {
        logger.debug("Déconnexion ignorée: événement provenant d'un ancien client XRPL", {
          code,
          generation,
          currentGeneration: this.clientGeneration,
        });
        return;
      }

      logger.warn(`Déconnecté du serveur XRPL (code ${code}). Tentative de reconnexion...`);

      this._reconnect(code).catch((err) => {
        logger.error("Erreur inattendue pendant la reconnexion XRPL", {
          error: err.message,
          stack: err.stack,
        });
      });
    });

    client.on("error", (errorCode, errorMessage) => {
      if (generation !== this.clientGeneration || client !== this.client) {
        return;
      }

      // xrpl.js peut émettre un événement global "error" pour noPermission
      // même si la requête est déjà catchée dans arbitrage.js.
      // On ne veut donc pas spammer ERROR pour ripple_path_find/path_find refusé.
      if (this._isPermissionNoise(errorCode, errorMessage)) {
        logger.debug("Commande XRPL refusée par ce serveur public, ignorée", {
          errorCode,
          errorMessage,
        });

        return;
      }

      logger.error("Erreur client XRPL", {
        errorCode,
        errorMessage,
      });
    });
  }

  _nextUrl() {
    this.currentUrlIndex = (this.currentUrlIndex + 1) % config.WS_URLS.length;
    return config.WS_URLS[this.currentUrlIndex];
  }

  async _createConnectedClient(url) {
    const client = new xrpl.Client(url, {
      connectionTimeout: 10000,
      timeout: 12000,
    });

    await client.connect();

    return client;
  }

  async _subscribeLedgerOnClient(client, generation) {
    if (!this.subscribedToLedger) return;

    try {
      await client.request({
        command: "subscribe",
        streams: ["ledger"],
      });

      for (const cb of this.ledgerCallbacks) {
        // Wrapper protégé : ignore les événements d'anciens clients.
        client.on("ledgerClosed", (...args) => {
          if (generation !== this.clientGeneration || client !== this.client) return;
          cb(...args);
        });
      }

      logger.info("Ré-abonnement au flux ledger effectué après connexion/reconnexion.");
    } catch (err) {
      logger.warn("Impossible de ré-abonner le flux ledger après reconnexion", {
        error: err.message,
      });
    }
  }

  async connect() {
    let lastError = null;

    for (let attempt = 0; attempt < config.WS_URLS.length; attempt++) {
      const url = config.WS_URLS[this.currentUrlIndex];

      try {
        logger.info(`Tentative de connexion à ${url}...`);

        const newClient = await this._createConnectedClient(url);

        this.clientGeneration++;
        const generation = this.clientGeneration;

        this.client = newClient;
        this._attachHandlers(newClient, generation);

        await this._subscribeLedgerOnClient(newClient, generation);

        logger.info(`Connecté à ${url}`);
        return this.client;
      } catch (err) {
        logger.warn(`Échec de connexion à ${url}`, {
          error: err.message,
        });

        lastError = err;
        this._nextUrl();
      }
    }

    throw new Error(
      `Impossible de se connecter à AUCUN des serveurs XRPL configurés (${config.WS_URLS.join(", ")}). ` +
        `Dernière erreur: ${lastError ? lastError.message : "inconnue"}`
    );
  }

  async _reconnect(disconnectCode = null) {
    // Empêche plusieurs reconnexions simultanées.
    if (this.reconnectPromise) {
      return this.reconnectPromise;
    }

    this.reconnectPromise = this._reconnectInternal(disconnectCode).finally(() => {
      this.reconnectPromise = null;
    });

    return this.reconnectPromise;
  }

  async _reconnectInternal(disconnectCode = null) {
    if (this.reconnecting) return;

    this.reconnecting = true;

    let attempt = 0;

    while (true) {
      attempt++;

      const url = this._nextUrl();

      // Code 1008 = souvent rate limit / policy violation.
      // On attend plus longtemps pour éviter de se faire couper en boucle.
      const baseBackoff = disconnectCode === 1008 ? 8000 : 2000;
      const backoffMs = Math.min(60000, baseBackoff * attempt);

      try {
        logger.info(`Reconnexion tentative ${attempt} vers ${url} (attente ${backoffMs}ms)...`);

        await sleep(backoffMs);

        const newClient = await this._createConnectedClient(url);

        const oldClient = this.client;

        this.clientGeneration++;
        const generation = this.clientGeneration;

        this.client = newClient;
        this._attachHandlers(newClient, generation);

        try {
          if (
            oldClient &&
            oldClient !== newClient &&
            typeof oldClient.isConnected === "function" &&
            oldClient.isConnected()
          ) {
            await oldClient.disconnect();
          }
        } catch (_) {
          // L'ancien client était probablement déjà fermé.
        }

        await this._subscribeLedgerOnClient(newClient, generation);

        this.reconnecting = false;

        logger.info(`Reconnecté avec succès à ${url}`);
        return;
      } catch (err) {
        logger.error(`Échec reconnexion tentative ${attempt}`, {
          error: err.message,
        });

        if (attempt >= 10) {
          logger.error("Trop d'échecs de reconnexion consécutifs. Arrêt du processus pour sécurité.");
          process.exit(1);
        }
      }
    }
  }

  async getCurrentLedgerIndex() {
    const client = this.getClient();
    return client.getLedgerIndex();
  }

  async getDynamicFeeDrops() {
    try {
      const client = this.getClient();

      const feeResponse = await client.request({
        command: "fee",
      });

      const openLedgerFee = Number(feeResponse.result.drops.open_ledger_fee);
      const minimalFee = Number(feeResponse.result.drops.minimum_fee);
      const recommended = Math.max(openLedgerFee, minimalFee);

      return String(Math.ceil(recommended * 1.5));
    } catch (err) {
      logger.warn("Impossible de récupérer les frais dynamiques, utilisation du minimum par défaut (10 drops)", {
        error: err.message,
      });

      return "10";
    }
  }

  async getAvailableBalanceXrp(address) {
    const breakdown = await this.getBalanceBreakdown(address);
    return breakdown.availableXrp;
  }

  async getBalanceBreakdown(address) {
    const client = this.getClient();

    const [accountInfo, serverState] = await Promise.all([
      client.request({
        command: "account_info",
        account: address,
      }),
      client.request({
        command: "server_state",
      }),
    ]);

    const balanceDrops = Number(accountInfo.result.account_data.Balance);
    const ownerCount = accountInfo.result.account_data.OwnerCount || 0;

    const validatedLedger = serverState.result.state.validated_ledger;
    const baseReserveDrops = Number(validatedLedger.reserve_base);
    const ownerReserveDrops = Number(validatedLedger.reserve_inc);

    const protocolReserveDrops = baseReserveDrops + ownerCount * ownerReserveDrops;
    const safetyBufferDrops = Number(config.MIN_XRP_RESERVE_BUFFER) * 1_000_000;
    const availableDrops = balanceDrops - protocolReserveDrops - safetyBufferDrops;

    return {
      totalXrp: balanceDrops / 1_000_000,
      protocolReserveXrp: protocolReserveDrops / 1_000_000,
      safetyBufferXrp: safetyBufferDrops / 1_000_000,
      availableXrp: Math.max(0, availableDrops / 1_000_000),
    };
  }

  async getAccountSequence(address) {
    const client = this.getClient();

    const info = await client.request({
      command: "account_info",
      account: address,
    });

    return info.result.account_data.Sequence;
  }

  async subscribeToLedgerClose(callback) {
    this.ledgerCallbacks.add(callback);
    this.subscribedToLedger = true;

    const client = this.getClient();

    await client.request({
      command: "subscribe",
      streams: ["ledger"],
    });

    const generation = this.clientGeneration;

    client.on("ledgerClosed", (...args) => {
      if (generation !== this.clientGeneration || client !== this.client) return;
      callback(...args);
    });

    logger.info("Abonné au flux de clôture de ledger.");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = XrplClient;