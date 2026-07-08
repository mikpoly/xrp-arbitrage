const xrpl = require("xrpl");
const logger = require("./logger");
const config = require("./config");

async function loadWallet(client) {
  if (config.WALLET_SEED) {
    const wallet = xrpl.Wallet.fromSeed(config.WALLET_SEED);
    logger.info(`Wallet chargé: ${wallet.address}`);

    try {
      await client.request({ command: "account_info", account: wallet.address });
    } catch (err) {
      if (err.data && err.data.error === "actNotFound") {
        throw new Error(
          `Le compte ${wallet.address} n'existe pas encore sur ${config.NETWORK}. ` +
            "Il doit recevoir au moins la réserve minimale avant de pouvoir trader."
        );
      }
      throw err;
    }

    return wallet;
  }

  if (config.NETWORK !== "testnet") {
    throw new Error("WALLET_SEED manquant. Obligatoire pour trader (mainnet ou testnet).");
  }

  logger.info("Aucune seed fournie -> génération d'un wallet testnet financé automatiquement...");
  const { wallet } = await client.fundWallet();
  logger.info(`Nouveau wallet testnet: ${wallet.address} — seed: ${wallet.seed}`);
  return wallet;
}

module.exports = { loadWallet };
