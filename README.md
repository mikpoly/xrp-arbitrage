# Bot d'arbitrage XRP Ledger — v3 (production)

## Ce qui a été ajouté depuis la v2

| Demande | Solution |
|---|---|
| `LastLedgerSequence` strict | `txSubmitter.js` calcule explicitement `currentLedger + 6` à chaque transaction, jamais de valeur floue par défaut |
| Codes de retour XRPL exhaustifs | `txResultCodes.js` : classification de tous les codes connus (tes/tec/tem/tef/ter) + fallback par préfixe pour les codes non listés |
| Gestion de `terQUEUED` | `txSubmitter.js` distingue le résultat préliminaire de soumission (qui peut être `terQUEUED`) du résultat final validé, et poll jusqu'à la validation réelle ou l'expiration propre |
| Persistance des états | `persistence.js` : PnL total/journalier, historique des trades, historique des erreurs, compteur de confirmations — tout survit à un redémarrage (`data/state.json`, écriture atomique) |
| Journalisation robuste | `logger.js` : niveaux configurables (`LOG_LEVEL`), fichiers `.jsonl` structurés par jour, buffer mémoire pour le dashboard, jamais de crash si le disque est plein |
| Interface graphique | `dashboard/` : mini-serveur Express + page web locale (statut, PnL, historique, logs en direct), accessible sur `http://localhost:4173` |
| Campagne de test en conditions réelles | `confirmGate.js` + `CONFIRM_FIRST_N_TRADES` : le bot demande une confirmation manuelle dans le terminal avant chaque trade réel, pour les N premiers (5 par défaut) |

Tous les modules critiques (`txResultCodes`, `persistence`, `riskManager`,
`txSubmitter`) ont été testés unitairement avec des scénarios simulés
(succès, `terQUEUED` puis validation, expiration propre) avant livraison —
voir le détail dans la conversation si besoin.

## ⚠️ Toujours vrai, et ça ne changera jamais

Aucun bot ne peut garantir de profit. La v3 corrige des failles d'ingénierie
réelles (atomicité, slippage, séquencement, persistance) — elle ne crée pas
d'opportunités de marché qui n'existent pas. Les bots professionnels avec
des serveurs colocalisés aux validateurs XRPL restent structurellement plus
rapides. Un bot personnel peut tourner des jours sans rien trouver de
rentable, et ce sera le comportement normal, pas un bug.

## Installation

```bash
npm install
cp .env.example .env
```

## Protocole de test recommandé (à suivre dans l'ordre)

### Étape 1 — Simulation sur testnet
```
NETWORK=testnet
DRY_RUN=true
```
Laisse tourner plusieurs heures. Vérifie `data/state.json` et le dashboard
(`http://localhost:4173`).

### Étape 2 — Simulation sur mainnet réel
```
NETWORK=mainnet
WALLET_SEED=ta_seed_dediee
DRY_RUN=true
```
Le bot observe le vrai marché sans risquer un centime. Regarde combien
d'opportunités réelles apparaissent sur plusieurs jours — ça te donne une
estimation honnête de la fréquence avant de risquer de l'argent.

### Étape 3 — Premiers trades réels, montants minuscules, confirmation manuelle
```
DRY_RUN=false
MAX_TRADE_XRP=1
CONFIRM_FIRST_N_TRADES=5
```
Le bot te demandera de taper `CONFIRM` dans le terminal avant chacun des 5
premiers trades réels. Observe chaque résultat dans le dashboard et les
logs (`logs/bot-YYYY-MM-DD.jsonl`) avant de continuer.

### Étape 4 — Montée en charge progressive
Augmente `MAX_TRADE_XRP` petit à petit sur plusieurs jours, en surveillant
`data/state.json` (PnL réel cumulé) à chaque palier. Ne saute jamais direct
à ton montant cible.

## Dashboard

```bash
npm start
```
Ouvre `http://localhost:4173` dans ton navigateur. Le dashboard affiche en
direct : mode (simulation/réel), PnL du jour et total, historique des
trades, dernier scan effectué, et le journal en temps réel. Il se
rafraîchit automatiquement toutes les 3 secondes. Désactive-le avec
`DASHBOARD_ENABLED=false` si tu n'en as pas besoin (ex: serveur distant
sans accès réseau au port).

## Architecture de détection : scan de marché complet (v3.1)

Depuis cette version, le bot ne teste plus une liste fixe de triangles.
À la place :

1. **`marketRates.js`** récupère le taux "top of book" entre toutes les
   paires de devises surveillées (voir `buildDefaultNodes` dans `orderBookArbitrage.js`).
2. **`marketGraph.js`** construit un graphe et cherche, avec l'algorithme de
   Bellman-Ford (détection de cycle de poids négatif — la méthode standard
   utilisée par les bots d'arbitrage XRPL documentés dans la littérature
   académique, ex. le papier "Jack the Rippler", IEEE/UCL), N'IMPORTE QUEL
   cycle rentable parmi ces devises, pas seulement des combinaisons à 3
   qu'on aurait pensé à tester à l'avance.
3. Si un cycle candidat est trouvé, **`orderBookArbitrage.js`** le vérifie
   PRÉCISÉMENT en marchant la profondeur réelle des carnets d'ordres pour le
   montant qu'on veut vraiment engager, avant de le retenir.
4. **`xrplClient.js`** s'abonne au flux de clôture de ledger XRPL
   (`ledgerClosed`) : le scan se déclenche à chaque nouveau bloc validé
   (~3-4s), pas sur un minuteur arbitraire qui peut tomber en plein milieu
   d'un intervalle sans rien de neuf à voir. `SCAN_INTERVAL_MS` reste actif
   comme filet de sécurité si jamais ce flux s'interrompt.

Tout ça a été testé avec des cas où la bonne réponse est connue à l'avance :
marché cohérent (aucune opportunité), opportunité simple à 3 devises,
opportunité rejetée car elle ne passe pas par XRP (inutilisable, on ne
détient que du XRP), et opportunité à 4 devises — un cas que l'ancien
système à triangles fixes ne pouvait structurellement pas trouver.

### Limite honnête sur la couverture

"Scan complet" veut dire complet PARMI les devises surveillées, pas
littéralement toutes les devises qui existent sur XRPL (plusieurs
milliers, dont l'immense majorité sans aucune liquidité). Scanner plus de
devises coûte plus cher en requêtes : avec N devises, un scan complet fait
environ N×(N-1) appels `book_offers` par cycle. Les serveurs publics comme
xrplcluster.com appliquent une limite d'usage équitable (documentée à
~1000 requêtes/minute/client) — la liste par défaut (4 devises, 12 appels/
cycle) reste largement en dessous. Ajoute des devises avec cette
contrainte en tête, et vérifie toujours une nouvelle adresse d'émetteur
avec `xrpl.isValidClassicAddress()` avant.

## Architecture complète

- `config.js` — chargement + validation stricte
- `logger.js` — logs multi-niveaux, fichiers `.jsonl`, buffer pour le dashboard
- `persistence.js` — sauvegarde/chargement de l'état (`data/state.json`), écriture atomique
- `txResultCodes.js` — classification exhaustive des codes de retour XRPL
- `txSubmitter.js` — soumission avec `LastLedgerSequence` strict, gestion de `terQUEUED` et de l'expiration
- `xrplClient.js` — connexion, reconnexion automatique, frais dynamiques, réserves, ledger courant
- `riskManager.js` — coupe-circuit, limite de perte journalière, persistance du PnL
- `arbitrage.js` — détection (`ripple_path_find`) et exécution atomique (`Payment`)
- `confirmGate.js` — confirmation manuelle terminal pour la campagne de test
- `wallet.js` — chargement et validation du wallet
- `bot.js` — orchestration, boucle principale, arrêt propre, démarrage du dashboard
- `dashboard/server.js` + `dashboard/public/index.html` — interface graphique locale
- `setup-testnet-tokens.js` — utilitaire testnet uniquement

## Limites restantes (honnêtes)

- Le dashboard est en lecture seule : il n'y a pas de bouton pour démarrer/arrêter
  le bot ou changer les paramètres depuis l'interface — modifie `.env` et
  redémarre `node bot.js`.
- La confirmation manuelle (`CONFIRM_FIRST_N_TRADES`) bloque la boucle dans le
  terminal : le bot n'exécute rien d'autre pendant que tu réponds.
- Aucune notification externe (email, Telegram...) n'est intégrée — dis-le moi
  si tu veux que j'ajoute des alertes.
