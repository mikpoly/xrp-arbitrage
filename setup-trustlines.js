const xrpl = require("xrpl");
const config = require("./config");
const logger = require("./logger");
const { loadWallet } = require("./wallet");

const TF_SET_NO_RIPPLE = 0x00020000;

function tokenKey(token) {
  return `${token.currency}.${token.issuer}`;
}

function shortToken(key, max = 64) {
  return key.length > max ? key.slice(0, max) + "..." : key;
}

async function readExistingTrustlines(client, account) {
  const existing = new Map();
  let marker = undefined;

  do {
    const response = await client.request({
      command: "account_lines",
      account,
      limit: 400,
      ...(marker ? { marker } : {}),
    });

    for (const line of response.result.lines || []) {
      const key = `${line.currency}.${line.account}`;
      existing.set(key, {
        key,
        currency: line.currency,
        issuer: line.account,
        balance: Number(line.balance || 0),
        limit: Number(line.limit || 0),
        noRipple: !!line.no_ripple,
      });
    }

    marker = response.result.marker;
  } while (marker);

  return existing;
}

async function submitTrustSet(client, wallet, token, limitValue) {
  const tx = {
    TransactionType: "TrustSet",
    Account: wallet.address,
    LimitAmount: {
      currency: token.currency,
      issuer: token.issuer,
      value: String(limitValue),
    },
    Flags: TF_SET_NO_RIPPLE,
  };

  if (config.SAFE_TRUSTLINE_DRY_RUN) {
    logger.info("DRY RUN TrustSet: transaction non envoyée", {
      token: tokenKey(token),
      tx,
    });

    return { dryRun: true, token: tokenKey(token) };
  }

  const prepared = await client.autofill(tx);
  const signed = wallet.sign(prepared);

  logger.info("Soumission TrustSet", {
    token: tokenKey(token),
    hash: signed.hash,
    limit: limitValue,
  });

  const result = await client.submitAndWait(signed.tx_blob);
  const code = result.result.meta.TransactionResult;

  if (code !== "tesSUCCESS") {
    throw new Error(`TrustSet échoué pour ${tokenKey(token)}: ${code}`);
  }

  logger.info("Trustline créée / mise à jour", {
    token: tokenKey(token),
    hash: signed.hash,
    code,
  });

  return { dryRun: false, token: tokenKey(token), hash: signed.hash, code };
}

async function main() {
  if (!Array.isArray(config.SAFE_TRUSTLINE_TOKENS) || config.SAFE_TRUSTLINE_TOKENS.length === 0) {
    logger.warn(
      "Aucun token configuré dans SAFE_TRUSTLINE_TOKENS. Ajoute une liste dans le .env avant de lancer ce script."
    );
    process.exit(0);
  }

  const limitValue = config.SAFE_TRUSTLINE_LIMIT;

  logger.info("=== Setup trustlines Safe Rotation XRPL ===", {
    network: config.NETWORK,
    dryRun: config.SAFE_TRUSTLINE_DRY_RUN,
    tokens: config.SAFE_TRUSTLINE_TOKENS.map(tokenKey),
    limitValue,
  });

  const client = new xrpl.Client(config.WS_URLS[0], {
    connectionTimeout: 10000,
    timeout: 12000,
  });

  await client.connect();

  try {
    const wallet = await loadWallet(client);
    const existing = await readExistingTrustlines(client, wallet.address);

    logger.info("État trustlines actuel", {
      wallet: wallet.address,
      existingTrustlines: existing.size,
    });

    let createdOrUpdated = 0;
    let skipped = 0;

    for (const token of config.SAFE_TRUSTLINE_TOKENS) {
      const key = tokenKey(token);
      const current = existing.get(key);
      const wantedLimit = Number(limitValue);

      if (current && Number.isFinite(current.limit) && current.limit >= wantedLimit) {
        skipped++;
        logger.info("Trustline déjà présente, ignorée", {
          token: shortToken(key),
          currentLimit: current.limit,
          balance: current.balance,
          noRipple: current.noRipple,
        });
        continue;
      }

      await submitTrustSet(client, wallet, token, limitValue);
      createdOrUpdated++;
    }

    logger.info("Setup trustlines terminé", {
      dryRun: config.SAFE_TRUSTLINE_DRY_RUN,
      createdOrUpdated,
      skipped,
    });
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => {
  logger.error("Erreur setup trustlines", {
    error: err.message,
    stack: err.stack,
  });

  process.exit(1);
});