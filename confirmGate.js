const readline = require("readline");
const logger = require("./logger");

/**
 * Bloque et demande à l'humain de taper CONFIRM avant d'exécuter un trade réel.
 * Utilisé pour les N premiers trades réels (CONFIRM_FIRST_N_TRADES), le temps
 * de vérifier en conditions réelles que tout se comporte comme prévu avant de
 * laisser le bot tourner en pleine autonomie.
 */
function askConfirmation(promptDetails) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log("\n=== CONFIRMATION MANUELLE REQUISE ===");
    console.log(promptDetails);
    rl.question('Tape "CONFIRM" puis Entrée pour exécuter ce trade réel, ou Entrée seule pour l\'ignorer : ', (answer) => {
      rl.close();
      const confirmed = answer.trim().toUpperCase() === "CONFIRM";
      if (!confirmed) logger.info("Trade ignoré : confirmation manuelle non reçue.");
      resolve(confirmed);
    });
  });
}

module.exports = { askConfirmation };
