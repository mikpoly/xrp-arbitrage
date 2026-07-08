const logger = require("./logger");

/**
 * MOTEUR DE DÉTECTION D'ARBITRAGE PAR GRAPHE.
 *
 * Principe (méthode standard en finance quantitative, utilisée par les vrais
 * bots d'arbitrage XRPL documentés dans la littérature académique) :
 *
 * 1. Chaque devise (XRP, USD:émetteur, EUR:émetteur...) est un NŒUD du graphe.
 * 2. Chaque carnet d'ordres entre deux devises est une ARÊTE dirigée, pondérée
 *    par -log(taux de change). Le -log transforme un problème de PRODUIT de
 *    taux (rentable si le produit > 1) en un problème de SOMME de poids
 *    (rentable si la somme < 0) — exactement ce que Bellman-Ford sait détecter :
 *    un "cycle de poids négatif".
 * 3. S'il existe un cycle de poids négatif atteignable depuis XRP, alors le
 *    produit des taux sur ce cycle est > 1 : c'est une opportunité d'arbitrage,
 *    quelle que soit sa longueur (pas limité à des triangles à 3 devises).
 *
 * Avantage sur des triangles codés en dur : on trouve N'IMPORTE QUEL cycle
 * rentable parmi les devises surveillées, y compris des chemins à 4, 5 hops
 * qu'on n'aurait pas pensé à tester manuellement.
 */

/**
 * Bellman-Ford avec détection ET reconstruction d'un cycle de poids négatif.
 *
 * @param {string[]} nodes - identifiants uniques de chaque devise (ex: "XRP", "USD.rIssuer...")
 * @param {Array<{from: string, to: string, weight: number}>} edges
 * @param {string} source - nœud de départ (typiquement "XRP")
 * @returns {string[] | null} la séquence de nœuds formant le cycle rentable, ou null si aucun
 */
function findNegativeCycle(nodes, edges, source) {
  const dist = {};
  const pred = {};
  for (const n of nodes) dist[n] = Infinity;
  dist[source] = 0;

  // |V|-1 relaxations : après ça, toutes les distances les plus courtes
  // (sans cycle négatif) sont stabilisées.
  for (let i = 0; i < nodes.length - 1; i++) {
    for (const edge of edges) {
      if (dist[edge.from] + edge.weight < dist[edge.to]) {
        dist[edge.to] = dist[edge.from] + edge.weight;
        pred[edge.to] = edge.from;
      }
    }
  }

  // Une relaxation supplémentaire encore possible = un cycle négatif existe
  // et est atteignable, avec `culprit` quelque part dedans ou en aval.
  let culprit = null;
  for (const edge of edges) {
    if (dist[edge.from] + edge.weight < dist[edge.to] - 1e-12) {
      culprit = edge.to;
      break;
    }
  }
  if (!culprit) return null;

  // On remonte |V| fois les prédécesseurs depuis `culprit` : ça garantit
  // d'atterrir DANS le cycle lui-même (pas juste sur un nœud qui y mène).
  let node = culprit;
  for (let i = 0; i < nodes.length; i++) {
    node = pred[node];
    if (node === undefined) return null; // sécurité : pas de cycle valide reconstruit
  }

  // Maintenant on trace le cycle complet à partir de ce nœud garanti-dans-le-cycle,
  // jusqu'à revoir ce même nœud.
  const cycle = [node];
  let current = pred[node];
  while (current !== node) {
    if (current === undefined || cycle.length > nodes.length + 1) return null; // garde-fou anti-boucle infinie
    cycle.push(current);
    current = pred[current];
  }
  cycle.push(node);
  cycle.reverse();

  // IMPORTANT : on ne détient que la devise `source` (XRP) dans le wallet.
  // Un cycle rentable qui ne PASSE PAS par `source` est inutilisable tel
  // quel (il faudrait un chemin d'entrée/sortie supplémentaire qu'on ne gère
  // pas ici). On rejette proprement plutôt que de faire semblant.
  const sourceIndex = cycle.indexOf(source);
  if (sourceIndex === -1) {
    logger.debug("Cycle négatif trouvé mais n'inclut pas la devise source, ignoré", { cycle });
    return null;
  }

  // On fait tourner le cycle pour qu'il commence (et finisse) par `source`.
  const rotated = [...cycle.slice(sourceIndex), ...cycle.slice(1, sourceIndex + 1)];
  return rotated;
}

/**
 * Construit les arêtes du graphe à partir des taux "top of book" (meilleur
 * prix affiché) entre chaque paire de devises pour lesquelles on a une
 * offre. C'est volontairement rapide/léger (pas de marche en profondeur du
 * carnet ici) — la vérification précise avec profondeur réelle se fait
 * ensuite, une fois qu'un cycle candidat est trouvé, avant toute exécution.
 */
function buildEdgesFromRates(rateMap) {
  const edges = [];
  for (const [fromTo, rate] of rateMap.entries()) {
    if (!rate || rate <= 0) continue;
    const [from, to] = fromTo.split("=>");
    edges.push({ from, to, weight: -Math.log(rate) });
  }
  return edges;
}

module.exports = { findNegativeCycle, buildEdgesFromRates };
