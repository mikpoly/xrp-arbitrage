/**
 * Ce script sert UNIQUEMENT pour la démo sur testnet.
 * Le testnet XRPL n'a pas d'émetteurs de USD/EUR établis comme le mainnet
 * (Bitstamp, GateHub...). Donc pour voir le bot fonctionner concrètement,
 * ce script :
 *   1. Crée 2 comptes "émetteurs" (testUSD, testEUR) financés par le faucet
 *   2. Fait en sorte que ton wallet leur fasse confiance (TrustSet)
 *   3. Place des offres dans le carnet d'ordres avec un écart de prix
 *      volontaire, pour simuler une opportunité d'arbitrage réelle
 *
 * Lance ce script UNE FOIS avant bot.js si tu veux tester en conditions
 * réelles sur testnet. Il affichera les adresses à mettre dans bot.js
 * (TRIANGLES) à la place des MAINNET_ISSUERS.
 */
const xrpl = require("xrpl");
const config = require("./config");

async function main() {
  if (config.NETWORK !== "testnet") {
    console.error("Ce script est réservé au testnet. Mets NETWORK=testnet dans .env.");
    process.exit(1);
  }

  const client = new xrpl.Client(config.WS_URL);
  await client.connect();

  console.log("Création des comptes émetteurs de test...");
  const { wallet: issuerUSD } = await client.fundWallet();
  const { wallet: issuerEUR } = await client.fundWallet();
  const { wallet: trader } = await client.fundWallet();

  console.log(`Émetteur testUSD : ${issuerUSD.address}`);
  console.log(`Émetteur testEUR : ${issuerEUR.address}`);
  console.log(`Wallet trader (utilise cette seed dans .env) : ${trader.seed}`);

  async function trust(wallet, currency, issuer, limit) {
    const tx = await client.autofill({
      TransactionType: "TrustSet",
      Account: wallet.address,
      LimitAmount: { currency, issuer, value: limit },
    });
    const signed = wallet.sign(tx);
    await client.submitAndWait(signed.tx_blob);
  }

  console.log("Configuration des trust lines...");
  await trust(trader, "USD", issuerUSD.address, "100000");
  await trust(trader, "EUR", issuerEUR.address, "100000");

  console.log("Émission de tokens de test vers le trader...");
  async function issue(issuerWallet, currency, destination, value) {
    const tx = await client.autofill({
      TransactionType: "Payment",
      Account: issuerWallet.address,
      Destination: destination,
      Amount: { currency, issuer: issuerWallet.address, value },
    });
    const signed = issuerWallet.sign(tx);
    await client.submitAndWait(signed.tx_blob);
  }
  await issue(issuerUSD, "USD", trader.address, "1000");
  await issue(issuerEUR, "EUR", trader.address, "1000");

  console.log(
    "\nNote: ce script NE crée PAS artificiellement un écart de prix — de vraies " +
      "opportunités d'arbitrage sont rares et disparaissent vite, un faux écart " +
      "permanent te donnerait une fausse impression de rentabilité. Si tu veux " +
      "voir le bot déclencher une transaction pour valider que tout fonctionne, " +
      "crée toi-même 2-3 offres avec des prix différents via OfferCreate " +
      "(voir exemple dans le README) puis relance bot.js."
  );

  console.log("\n=== Configuration terminée ===");
  console.log("Copie ces valeurs dans bot.js (remplace MAINNET_ISSUERS par ces adresses) :");
  console.log(`  issuerA (USD): ${issuerUSD.address}`);
  console.log(`  issuerB (EUR): ${issuerEUR.address}`);
  console.log("Et mets WALLET_SEED dans .env avec :", trader.seed);

  await client.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
