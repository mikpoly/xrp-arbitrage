/**
 * Classification des codes de retour XRPL.
 * Référence officielle: https://xrpl.org/docs/references/protocol/transactions/transaction-results
 *
 * Catégories (par préfixe du code) :
 *   tes  = succès définitif (1 seul code: tesSUCCESS)
 *   tec  = échec mais INCLUS DANS LE LEDGER (frais prélevés, état inchangé sinon).
 *          Définitif : ne se reproduira pas en réessayant la même transaction.
 *   tem  = malformée. Définitif, ne sera JAMAIS acceptée telle quelle (bug de code).
 *   tef  = a échoué et ne sera jamais retentée par le serveur (ex: séquence déjà utilisée).
 *          Définitif dans la plupart des cas.
 *   ter  = échec LOCAL temporaire, peut réussir si retentée (ex: terQUEUED, terPRE_SEQ).
 *          PAS définitif : le serveur peut retenir automatiquement la transaction.
 *   tel  = rejet local avant même la soumission au réseau (rare via xrpl.js, plutôt côté rippled)
 */

const KNOWN_CODES = {
  tesSUCCESS: {
    category: "success",
    definitive: true,
    retryable: false,
    message: "Transaction exécutée avec succès et validée par le réseau.",
  },

  // --- tec : inclus dans un ledger mais échec fonctionnel (frais prélevés) ---
  tecPATH_DRY: {
    category: "tec",
    definitive: true,
    retryable: true,
    message: "Aucun chemin de conversion disponible pour ce montant au moment de la validation. Le marché a bougé.",
  },
  tecPATH_PARTIAL: {
    category: "tec",
    definitive: true,
    retryable: true,
    message: "Le chemin ne peut livrer le montant demandé sans dépasser SendMax. Opportunité disparue avant validation.",
  },
  tecUNFUNDED_PAYMENT: {
    category: "tec",
    definitive: true,
    retryable: false,
    message: "Solde insuffisant au moment de la validation.",
  },
  tecNO_DST: {
    category: "tec",
    definitive: true,
    retryable: false,
    message: "Compte destinataire inexistant.",
  },
  tecNO_DST_INSUF_XRP: {
    category: "tec",
    definitive: true,
    retryable: false,
    message: "Compte destinataire inexistant et montant insuffisant pour le créer.",
  },
  tecINSUFFICIENT_RESERVE: {
    category: "tec",
    definitive: true,
    retryable: false,
    message: "Réserve XRP insuffisante pour cette opération (ex: trustline supplémentaire).",
  },
  tecOVERSIZE: {
    category: "tec",
    definitive: true,
    retryable: true,
    message: "Chemin de paiement trop complexe (trop d'étapes) pour être traité.",
  },
  tecEXPIRED: {
    category: "tec",
    definitive: true,
    retryable: true,
    message: "Transaction expirée (LastLedgerSequence dépassé) au moment du traitement.",
  },
  tecKILLED: {
    category: "tec",
    definitive: true,
    retryable: true,
    message: "Offre FillOrKill non exécutable intégralement, annulée comme prévu.",
  },
  tecNO_LINE_INSUF_RESERVE: {
    category: "tec",
    definitive: true,
    retryable: false,
    message: "Réserve insuffisante pour créer une nouvelle trustline.",
  },

  // --- tem : malformée, ne sera jamais acceptée (bug de code à corriger) ---
  temBAD_AMOUNT: { category: "tem", definitive: true, retryable: false, message: "Montant invalide dans la transaction (bug de code)." },
  temBAD_CURRENCY: { category: "tem", definitive: true, retryable: false, message: "Code de devise invalide (bug de code)." },
  temREDUNDANT: { category: "tem", definitive: true, retryable: false, message: "Transaction sans effet réel (source = destination, montants nuls...)." },
  temMALFORMED: { category: "tem", definitive: true, retryable: false, message: "Transaction malformée (bug de code à corriger avant de retenter)." },

  // --- tef : ne sera jamais retentée par le serveur ---
  tefPAST_SEQ: { category: "tef", definitive: true, retryable: false, message: "Numéro de séquence déjà utilisé. Resynchronise la séquence du compte." },
  tefMAX_LEDGER: { category: "tef", definitive: true, retryable: true, message: "LastLedgerSequence dépassé avant inclusion. Retente avec une nouvelle séquence." },
  tefALREADY: { category: "tef", definitive: true, retryable: false, message: "Transaction identique déjà soumise." },

  // --- ter : échec LOCAL temporaire, PAS définitif, peut réussir en attendant ---
  terQUEUED: {
    category: "ter",
    definitive: false,
    retryable: true,
    message: "Transaction mise en file d'attente par le serveur (frais insuffisants pour le ledger courant). Attends la validation, ne resoumets pas immédiatement.",
  },
  terPRE_SEQ: {
    category: "ter",
    definitive: false,
    retryable: true,
    message: "Numéro de séquence trop élevé (transaction précédente pas encore validée). Attends.",
  },
  terNO_AUTH: { category: "ter", definitive: false, retryable: true, message: "Autorisation requise manquante (peut se résoudre)." },
  terINSUF_FEE_B: { category: "ter", definitive: false, retryable: true, message: "Solde insuffisant pour couvrir les frais proposés au moment du test local." },
};

const CATEGORY_DEFAULTS = {
  tes: { category: "success", definitive: true, retryable: false, message: "Succès." },
  tec: { category: "tec", definitive: true, retryable: true, message: "Échec inclus dans le ledger (frais prélevés). Vérifie la cause précise, le marché a probablement bougé." },
  tem: { category: "tem", definitive: true, retryable: false, message: "Transaction malformée. Ne pas retenter sans corriger le code." },
  tef: { category: "tef", definitive: true, retryable: false, message: "Échec définitif côté serveur. Ne pas retenter telle quelle." },
  ter: { category: "ter", definitive: false, retryable: true, message: "Échec local temporaire. Peut être retentée ou résolue automatiquement par le serveur." },
  tel: { category: "tel", definitive: false, retryable: true, message: "Rejet local avant diffusion au réseau. Peut être retentée." },
};

/**
 * Retourne une classification structurée pour n'importe quel code XRPL,
 * même ceux non listés explicitement ci-dessus (fallback par préfixe).
 */
function classify(code) {
  if (!code || typeof code !== "string") {
    return { code: String(code), category: "unknown", definitive: false, retryable: true, message: "Code de retour absent ou invalide." };
  }

  if (KNOWN_CODES[code]) {
    return { code, ...KNOWN_CODES[code] };
  }

  const prefix = code.slice(0, 3);
  if (CATEGORY_DEFAULTS[prefix]) {
    return { code, ...CATEGORY_DEFAULTS[prefix], message: `${CATEGORY_DEFAULTS[prefix].message} (code non répertorié explicitement: ${code})` };
  }

  return { code, category: "unknown", definitive: false, retryable: true, message: `Code inconnu non documenté: ${code}. Traité par prudence comme non-définitif.` };
}

module.exports = { classify };
