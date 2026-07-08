const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const LEVELS = { ERROR: 0, WARN: 1, TRADE: 1, INFO: 2, DEBUG: 3 };
const configuredLevel = (process.env.LOG_LEVEL || "INFO").toUpperCase();
const minLevel = LEVELS[configuredLevel] !== undefined ? LEVELS[configuredLevel] : LEVELS.INFO;

let currentDay = null;
let stream = null;

function getStream() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== currentDay || !stream) {
    if (stream) stream.end();
    currentDay = today;
    const file = path.join(LOG_DIR, `bot-${today}.jsonl`);
    stream = fs.createWriteStream(file, { flags: "a" });
    stream.on("error", (err) => {
      // On évite de faire planter le bot si le disque est plein ou le fichier
      // inaccessible : on retombe sur la console uniquement.
      console.error(`[logger] Erreur d'écriture du fichier de log: ${err.message}`);
    });
  }
  return stream;
}

// Historique en mémoire des dernières lignes, pour affichage rapide dans le dashboard
// sans avoir à relire le fichier disque à chaque requête.
const RING_BUFFER_SIZE = 300;
const ringBuffer = [];

function pushRingBuffer(entry) {
  ringBuffer.push(entry);
  if (ringBuffer.length > RING_BUFFER_SIZE) ringBuffer.shift();
}

function write(level, msg, meta) {
  if ((LEVELS[level] ?? LEVELS.INFO) > minLevel) return;

  const entry = { timestamp: new Date().toISOString(), level, msg, ...(meta ? { meta } : {}) };
  const humanLine = `[${entry.timestamp}] [${level}] ${msg}${meta ? " " + JSON.stringify(meta) : ""}`;

  if (level === "ERROR") console.error(humanLine);
  else console.log(humanLine);

  pushRingBuffer(entry);

  try {
    getStream().write(JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error(`[logger] Impossible d'écrire dans le fichier de log: ${err.message}`);
  }
}

module.exports = {
  info: (msg, meta) => write("INFO", msg, meta),
  warn: (msg, meta) => write("WARN", msg, meta),
  error: (msg, meta) => write("ERROR", msg, meta),
  trade: (msg, meta) => write("TRADE", msg, meta),
  debug: (msg, meta) => write("DEBUG", msg, meta),
  getRecentLogs: (n = 100) => ringBuffer.slice(-n),
};
