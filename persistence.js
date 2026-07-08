const fs = require("fs");
const path = require("path");
const logger = require("./logger");

const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

const DEFAULT_STATE = {
  totalPnlXrp: 0,
  dailyPnlXrp: 0,
  dailyResetAt: null, // ISO string, recalculé au chargement si absent/périmé
  consecutiveFailures: 0,
  breakerTrippedUntil: null,
  tradesExecuted: 0,
  manualConfirmationsUsed: 0, // combien de trades réels ont déjà été validés manuellement au démarrage
  tradeHistory: [], // { timestamp, hash, result, pnlXrp, note } — capé à MAX_HISTORY
  errorHistory: [], // { timestamp, message } — capé à MAX_HISTORY
  startedAt: new Date().toISOString(),
};

const MAX_HISTORY = 500;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDataDir();
  if (!fs.existsSync(STATE_FILE)) {
    logger.info("Aucun état persisté trouvé, démarrage avec un état neuf.");
    return { ...DEFAULT_STATE };
  }

  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    logger.info("État persisté chargé depuis data/state.json", {
      totalPnlXrp: parsed.totalPnlXrp,
      tradesExecuted: parsed.tradesExecuted,
    });
    return { ...DEFAULT_STATE, ...parsed };
  } catch (err) {
    logger.error("Impossible de lire l'état persisté, démarrage avec un état neuf (fichier corrompu ?)", {
      error: err.message,
    });
    // On sauvegarde le fichier corrompu pour inspection plutôt que de l'écraser silencieusement
    try {
      fs.renameSync(STATE_FILE, STATE_FILE + `.corrupted-${Date.now()}`);
    } catch (_) {
      /* ignore */
    }
    return { ...DEFAULT_STATE };
  }
}

/**
 * Écriture atomique : on écrit dans un fichier temporaire puis on renomme.
 * Ça évite de corrompre le fichier si le process est tué en plein milieu
 * d'une écriture (rename est atomique sur la plupart des systèmes de fichiers).
 */
function save(state) {
  ensureDataDir();
  const tmpFile = STATE_FILE + ".tmp";
  try {
    // On cape les historiques pour ne pas laisser grossir le fichier indéfiniment
    const toSave = {
      ...state,
      tradeHistory: (state.tradeHistory || []).slice(-MAX_HISTORY),
      errorHistory: (state.errorHistory || []).slice(-MAX_HISTORY),
    };
    fs.writeFileSync(tmpFile, JSON.stringify(toSave, null, 2), "utf8");
    fs.renameSync(tmpFile, STATE_FILE);
  } catch (err) {
    logger.error("Échec de la sauvegarde de l'état persisté", { error: err.message });
  }
}

module.exports = { load, save, DEFAULT_STATE, MAX_HISTORY };
