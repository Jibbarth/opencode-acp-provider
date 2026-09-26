# opencode-acp-provider

Expose un agent **ACP** ([Agent Client Protocol](https://agentclientprotocol.com))
comme **model provider OpenCode** : les modèles de l'agent apparaissent dans
`/model` d'OpenCode, et chaque tour passe par un `Transport` ACP sur stdio.

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-acp-provider",
      "options": { "agents": [{ "command": "copilot", "args": ["--acp"] }] }
    }
  ]
}
```

## État d'avancement

Le projet suit les phases du `PLAN.md`. Où en est-on, sans arrondir :

| Phase | État |
| --- | --- |
| P0 — client ACP (`initialize`, `session/new`) | fait, testé contre `copilot --acp` |
| P1 — `Transport` Effect sur stdio | fait, testé (bout-en-bout contre un faux agent) |
| P2 — mapping `AcpEvent` → `LLMEvent` | fait, testé séquence par séquence |
| P2b — l'agent **propose** l'outil, OpenCode l'exécute (§7.3) | fait, testé |
| **P3a — plugin : provider + `Model.Info`, variantes d'effort** | **fait et testé dans un vrai OpenCode** |
| **P3b — recette réelle** : `acp/<modèle>` visible dans `/model`, un tour complet | **fait, vérifié** |
| P4 — permissions fines, erreurs §8 | à faire (`session/cancel` fait, voir « Annulation ») |
| R1 — sessions ACP persistantes (`PLAN.md` §10) | fait, testé (voir « Sessions persistantes ») |
| R2 — plusieurs agents, un provider par agent | fait, testé (voir « Plusieurs agents ») |
| P6 — variantes par modèle, serveurs MCP versés à l'agent | à faire |
| P7 — adaptateur HTTP `/v1/chat/completions` | à faire |

**Ce qui a été vérifié pour de vrai, bout en bout.** Dans un vrai `opencode serve`,
le plugin se charge (`opencode-acp-provider | local | active`), le provider `acp` est
enregistré avec `package: file://…/src/index.ts`, **19 modèles** paraissent dans
`/model` avec leurs noms et leurs variantes d'effort, et un tour de conversation via
`acp/claude-sonnet-5` renvoie la réponse attendue :

```
acp/claude-sonnet-5 | finish=stop | tokens=2/24
   texte: BONJOUR-ACP
```

⚠️ **Piège de recette, à connaître.** `opencode models` sort **avant** que les plugins
aient fini de charger : il affiche zéro modèle `acp/` sans que quoi que ce soit soit faux,
et le résultat est intermittent d'un run à l'autre. Pour vérifier, il faut un **serveur
persistant** : `opencode serve --port N`, puis interroger `/api/plugin` et `/api/model`
en basic auth `opencode:<mot de passe>` (le mot de passe est affiché au démarrage).

### Limites connues

- **`auto` est filtré.** C'est une pseudo-valeur : l'agent choisit le modèle à
  chaque tour sans le dire, donc un `Model.Info` serait faux (limites, coût) sans
  jamais le signaler. Voir `PSEUDO_MODEL_IDS` dans `src/core/publish.ts`.
- **`allowedTools` est dégradé en interrupteur.** `["*"]` autorise tout le natif,
  toute autre liste se comporte comme « tout refuser » : la demande de
  permission ACP ne porte pas toujours le nom de l'outil. C'est le choix
  *fail-safe* du §7.4, pas un oubli.
- **`session: "reuse"` est une heuristique, pas une garantie.** Voir
  « Sessions persistantes » : la reprise ne vaut que si l'historique reçu est
  exactement une extension de celui déjà envoyé, et toute divergence (édition,
  fork, `/compact`, changement de modèle) retombe sur une session neuve. Le
  défaut reste `"fresh"`.
- **`reuse` gonfle le compteur de tokens d'OpenCode.** Mesuré : sur une session
  reprise, `copilot` annonce un `input` cumulé (≈ 4,4× sa fenêtre réelle), que
  nous forwardons tel quel. La fenêtre de l'agent n'est pas affectée ; le seuil de
  `/compact`, si. Voir « Sessions persistantes ».
- **Le rafraîchissement est déclenché, pas continu.** L'inventaire est relu au
  plus une fois par `refreshMs` (60 s par défaut), et seulement après un
  `session.idle`. Le `config_option_update` des sessions du transport n'est pas
  observé : le contrat portable `AcpSession` ne l'expose qu'en cours de prompt.
- **Limites déclarées, pas mesurées.** ACP ne publie aucune capacité de modèle ;
  on annonce 200 000 / 32 000 par défaut, réglable par agent
  (`agents[].limits`). Un `limit.context` trop grand ne fait que retarder la
  compaction.
- **Entrées texte seulement.** `copilot --acp` accepte les images, mais le
  réducteur ne sait pas les rendre : annoncer `input: ["text"]` vaut mieux qu'une
  image acceptée puis perdue en silence.
- **Un deuxième process.** La découverte lance son propre agent, distinct de
  celui que le transport lancera par `model()`. Partager le cache de
  `opencode-transport.ts` chargerait toute la pile `effect` + `@opencode/ai` au
  chargement du plugin, dans le process du serveur.
- **Un plugin absent ne se voit pas… sauf une ligne.** Un package qui ne se
  charge ne produit aucune erreur ; `src/plugin.ts` écrit donc sur `stderr`, au
  moment où le module est **évalué** et **hors du `try` de `setup`**, une seule
  ligne `[opencode-acp-provider] module évalué : file://…/src/plugin.ts`. Si elle
  manque, le problème est en amont (chemin, installation, erreur d'import) ; si
  elle est là, tout ce qu'il reste à lire est le journal de `setup`. C'est
  précisément pour cela qu'elle est écrite là : nulle part ailleurs elle ne
  distinguerait les deux cas.
- **Les outils namespacés sont aplatis dans le prompt.** L'agent doit reproduire
  le nom tel quel, et c'est `namespace_nom` — la convention de `@opencode/ai`
  pour les protocoles sans namespace natif (`.` n'est pas accepté partout). Le
  `tool-call` émis porte en plus le `namespace` d'origine, sinon le runtime
  d'OpenCode, qui indexe son registre par `namespace.nom`, ne retrouverait pas
  l'outil.

## Annulation

`Esc` interrompt proprement, et « proprement » veut dire trois choses, toutes
vérifiées par `test/cancel.test.ts` :

1. **l'agent est prévenu.** Le `TransportRuntime` d'`@opencode/ai` ne porte
   aucun signal d'interruption : quand OpenCode abandonne le stream, le `Scope`
   se ferme et… rien d'autre ne se passe. Un contrôleur d'annulation armé par un
   finalizer du **même** `Scope` envoie donc `session/cancel`, enregistré
   **après** l'ouverture de la session pour que les finalizers — qui s'exécutent
   en ordre inverse — produisent `session/cancel` puis `session/close`. Le faux
   agent note chaque annulation reçue dans un fichier : un retour rapide ne
   prouve rien, un `session/cancel` daté si.
2. **le temps est celui de l'annulation, pas celui du tour.** Interrompre un tour
   de 30 s rend la main en quelques centaines de ms, et le flux s'arrête sans
   `finish` orphelin.
3. **rien ne fuit.** Un tour annulé ne rend ni la session ni l'agent
   inutilisables, et le processus n'est pas tué (il est mis en cache et réutilisé,
   c'est voulu) — mais il n'est jamais laissé sans propriétaire.

⚠️ En `session: "reuse"`, un tour **annulé** abandonne en plus la session ACP
elle-même : sa mémoire ne peut plus être considérée comme fiable (l'agent a pu
s'arrêter au milieu d'un tour), donc elle est fermée et le tour suivant repart
d'une session neuve avec tout l'historique. C'est le repli `fail-safe` : perdre
une session coûte un `session/new`, reprendre une session incohérente corrompt
le contexte de l'agent sans aucun signe.

## Sessions persistantes

Par défaut (`session: "fresh"`), chaque tour ouvre une session ACP neuve et
renvoie **tout** l'historique dans le prompt. C'est correct, et c'est lent.

Avec `session: "reuse"`, une **session ACP durable par conversation** est
réutilisée d'un tour à l'autre, et **seul le delta** — les messages ajoutés
depuis le dernier tour — est envoyé. L'agent garde ainsi sa propre mémoire, et le
prompt cesse de grossir linéairement.

```jsonc
{ "command": "copilot", "args": ["--acp"], "session": "reuse" }
```

### Ce que la reprise apporte — et ce qu'elle n'apporte pas

**Mesuré sur `copilot --acp` v1.0.88** (agent `Copilot`), sonde
`npm run verify:resume` : quatre tours, même script dans les deux modes, tour 1
qui pose un nom de fichier à retenir.

| | tour 1 | tour 2 | tour 3 | tour 4 |
| --- | --- | --- | --- | --- |
| `reuse` — durée | 4 761 ms | 1 518 ms | 3 383 ms | 1 547 ms |
| `fresh` — durée | 8 251 ms | 2 940 ms | 7 539 ms | 9 788 ms |
| `reuse` — `cacheWrite` | 17 629 | 18 377 | 19 045 | 19 764 |
| `fresh` — `cacheWrite` | 17 628 | 17 684 | 17 737 | 17 789 |
| `reuse` — `input` | 17 632 | 36 012 | 55 060 | 74 827 |
| `fresh` — `input` | 17 631 | 17 687 | 17 740 | 17 792 |

**La reprise n'apporte pas de mémoire : les deux modes s'en souviennent.** Sur les
quatre tours, `copilot` a restitué le nom du fichier **8 fois sur 8**, en `reuse`
comme en `fresh`. C'est expected — et c'est ce que contredit l'affirmation
« un agent oublie tout entre deux tours » : en `fresh`, l'historique **rejoué
dans le prompt** porte déjà l'information. Une session neuve n'amnésique pas,
elle relit.

Ce que la reprise apporte, en revanche, se lit dans `cacheWrite` :

- en **`fresh`**, le prompt reconstruit est un **texte nouveau** à chaque tour :
  l'agent le réécrit dans son cache à chaque fois (~17 700 par tour, indéfiniment) ;
- en **`reuse`**, le préfixe est déjà dans la mémoire de l'agent : il n'écrit que
  le delta (~750 à 1 900 par tour).

D'où une latence par tour **~3× moindre** et plate, contre une latence qui
**croit** avec la conversation en `fresh`.

⚠️ Le contrepartie est dans la même colonne : `input` **croit linéairement** en
`reuse` (17 k → 75 k sur quatre tours) alors qu'il reste plat en `fresh`. La
première explication — « la session de l'agent contient tout ce qu'il a déjà reçu »
— **est fausse, et la mesure le montre**. En `fresh`, l'historique rendu dans le
prompt occupe exactement la même place dans la fenêtre de l'agent ; ce n'est pas
l'accumulation côté session qui differentiate les deux modes.

Ce que `input` vaut vraiment, c'est le **compteur de cache cumulé de la session**
sur une session reprise : `cacheRead + cacheWrite`, soit 106 805 + 29 962 = 136 767
pour un `input` de 136 785 au tour 6, là où la fenêtre réelle en occupe 30 809.
Relevé par `npm run verify:sessions` (six tours, remplissage contrôlé), en
comparant `input` au `usage_update.used` que l'agent annonce lui-même :

| tour 6, remplissage 9 000 car./tour | `input` rapporté | contexte réel (`usage_update`) |
| --- | --- | --- |
| `fresh` | 26 674 | 27 620 |
| `reuse` | 136 785 | 30 809 |

Donc les **fenêtres réelles se remplissent à la même vitesse** dans les deux modes
(≈ 2 200 jetons/tour en `fresh`, ≈ 2 850 en `reuse`) — l'agent n'est jamais le
facteur limitant, et `reuse` n'atteint pas sa fenêtre plus tôt que `fresh`.

Le chiffre qui reste problématique est l'autre. `input` est ce que
`adapters/opencode-protocol.ts` forward à `Usage.inputTokens` : **136 785 au lieu
de 30 809**, soit un facteur 4,4. C'est ce compte que l'interface affiche et que
le seuil de `/compact` d'OpenCode finit par rencontrer. (Ce qui est mesuré ici :
le forwarding et le facteur ; le seuil exact d'OpenCode et sa façon d'agréger les
usages par message ne sont pas dans ce dépôt et n'ont pas été extraits.)

En `reuse`, une conversation se ferait donc compacter trop tôt, et l'indicateur
de tokens afficherait un contexte qui n'existe pas. C'est la raison mesurée pour
laquelle `fresh` reste le défaut — et elle n'a rien à voir avec un oubli de
l'agent.

Ce que la reprise n'apporte donc **pas** : une mémoire que `fresh` n'aurait pas.
Ce qu'elle apporte : un prompt et une latence par tour constants. `fresh` reste le
défaut — plus simple, correct, et le seul à annoncer un comptage de tokens exact.

### Comment une conversation est reconnue

`LLMRequest` ne porte **ni `sessionID` ni `cwd`** (§9bis), donc il n'existe aucun
identifiant à opposer à une session ACP. La reconnaissance repose sur deux
niveaux, et c'est cette séparation qui rend la reprise sûre :

1. **une clé d'indexation** — `sha256(agent + cwd + modèle + premier message)`.
   Stable malgré la croissance de la conversation : c'est elle qui permet de
   retrouver « la session vivante de cette conversation » en O(1).
2. **une preuve de continuité** — la session retenue a reçu `N` messages ; le tour
   n'est repris que si l'historique reçu est **exactement** une extension de
   ceux-là, message par message. Au moindre écart, la session est fermée et on
   repart d'une session neuve avec tout l'historique.

La clé est une **astuce d'indexation** ; la continuité est une **garantie**. La
preuve porte sur l'historique *entier*, pas sur un préfixe : deux conversations
qui partagent leurs N premiers messages et divergent ensuite ne peuvent donc pas
se voler une session — c'est précisément le cas qu'une empreinte de préfixe ne
détecterait pas.

| Cas | Ce qui se passe |
| --- | --- |
| Tour suivant normal | Delta envoyé, session réutilisée |
| Message **édité** | Empreinte différente à ce rang → session neuve, tout l'historique |
| **Fork**, prépend | Idem |
| `/compact` (historique raccourci) | Idem |
| **Changement de modèle** | Clé différente → session neuve (une session a appliqué son modèle par `set_config_option`) |
| `cwd` ou agent différent | Clé différente → session neuve |
| Rejeu du même tour | Delta vide refusé → session neuve (un prompt sans message produirait un `ACK:` muet) |
| Tour annulé, agent mort | Session **empoisonnée** → fermée, tour suivant sur une session neuve |
| Hors LRU (8 sessions) | La moins récemment utilisée est fermée, **sauf** si elle porte un tour |

⚠️ Ce que la reprise **ne** fait pas : le système, le catalogue d'outils et le
contrat de sortie sont **renvoyés en entier à chaque tour**. Seule l'historique
est deltaïsé — c'est l'historique qui double, pas les instructions. La section
transcript est alors titrée « Conversation — suite », avec une ligne qui dit à
l'agent que la suite a déjà été échangée et qu'il ne doit pas la répéter.

⚠️ Deux requêtes **sur la même conversation** sont mises en file FIFO : ACP
refuse deux `session/prompt` concurrents sur une session, et les notifications
des deux tours seraient indiscernables. Deux conversations différentes ont deux
clés, donc deux files : elles tournent en parallèle.

Les sessions retenues sont fermées au déchargement du plugin et par
`closeAllSessions()` ; le LRU est borné à 8 sessions par agent, et n'évince
jamais une session qui porte un tour en cours.

## Installation

Le paquet expose deux points d'entrée : le **plugin** (chargé par OpenCode) et
le **provider** (le champ `package` du `Provider.Info`, qui pointe sur
`src/index.ts` en local ou `dist/index.js` après un build). L'URL est calculée
depuis `import.meta.url`, donc les deux layouts fonctionnent.

En local, sans build (un chemin relatif est résolu depuis le fichier de
configuration) :

```jsonc
{
  "plugins": [
    {
      "package": "./chemin/vers/opencode-acp-provider/src/plugin.ts",
      "options": { "agents": [{ "command": "copilot", "args": ["--acp"] }] }
    }
  ]
}
```

Installé (npm) :

```jsonc
{
  "plugins": [
    {
      "package": "opencode-acp-provider",
      "options": { "agents": [{ "command": "copilot", "args": ["--acp"] }] }
    }
  ]
}
```

Prérequis : **Bun** (le plugin et le provider tournent dans le process Bun
d'OpenCode), l'agent ACP installé et authentifié, et un OpenCode dont la version
correspond à celle de `@opencode/plugin` (voir « Versions » plus bas).

## Configuration

Tout se passe dans `plugins[].options`. Sans configuration, l'agent par défaut est
`copilot --acp`.

| Champ | Type | Défaut | Rôle |
| --- | --- | --- | --- |
| `agents` | `AgentConfig[]` | `[{ "command": "copilot", "args": ["--acp"] }]` | Les agents à découvrir ; **chacun devient un provider** |
| `refreshMs` | `number` | `60000` | Délai minimum entre deux redécouvertes ; `0` désactive |
| `discoveryTimeoutMs` | `number` | `10000` | Borne haute de la découverte (lancement + `initialize` + inventaire) |
| `discoveryIdleTimeoutMs` | `number` | `10000` | Délai maximum sans signe de vie de l'agent pendant la découverte |

`discoveryTimeoutMs` et `discoveryIdleTimeoutMs` existent parce que `setup()`
est **awaité par l'hôte** : c'est le seul endroit du projet où une attente peut
bloquer le chargement d'OpenCode. Les deux bornes sont vidées dans un `finally`,
donc un minuteur résiduel ne retient jamais le process du serveur en vie. Un
agent qui démarre lentement se règle en **augmentant** `discoveryTimeoutMs` — la
borne d'inactivité, elle, autorise tout agent qui **parle** (son stderr la
remet à zéro) à disposer de toute la borne globale. Un agent abandonné en cours
de route est tué dès qu'il existe : aucun orphelin par chargement de plugin.

`AgentConfig` :

| Champ | Type | Rôle |
| --- | --- | --- |
| `command` | `string` **obligatoire** | La commande à lancer |
| `args` | `string[]` | Les arguments (`["--acp"]`) |
| `cwd` | `string` | Répertoire de travail de l'agent (le process est *partagé* entre toutes les requêtes — cf. `PLAN.md` §9bis) |
| `env` | `Record<string,string>` | Variables **ajoutées** à celles du serveur |
| `allowedTools` | `string[]` | `["*"]` = tout autoriser ; absent = tout refuser (§7.4) |
| `limits` | `{ context, output }` | Limites annoncées dans `/model` |
| `id` | `string` | Étiquette **et** identifiant de provider ; défaut : aucun (`acp`) |
Exemple :

```jsonc
{
  "plugins": [
    {
      "package": "opencode-acp-provider",
      "options": {
        "refreshMs": 30000,
        "agents": [
          {
            "id": "copilot",
            "command": "copilot",
            "args": ["--acp"],
            "env": { "HTTPS_PROXY": "http://proxy.local:3128" },
            "limits": { "context": 200000, "output": 32000 }
          }
        ]
      }
    }
  ]
}
```

## Plusieurs agents

Chaque entrée de `agents` donne **un provider** : son propre inventaire de
modèles, ses propres variantes d'effort, son propre process d'agent et son propre
pool de sessions ACP.

```jsonc
{
  "plugins": [
    {
      "package": "opencode-acp-provider",
      "options": {
        "agents": [
          { "id": "copilot", "command": "copilot", "args": ["--acp"] },
          { "command": "npx", "args": ["-y", "@agentclientprotocol/codex-acp"] }
        ]
      }
    }
  ]
}
```

`/model` affiche alors `acp-copilot/claude-sonnet-5` **et** `acp/claude-sonnet-5`
côte à côte, et le réglage se fait par provider :

```jsonc
{ "provider": { "acp-copilot": { "options": { "session": "reuse" } } } }
```

### Choisir un mode de session par agent

`agents[].session` est le moyen de **déclarer le mode dans l'entrée d'agent**,
c'est-à-dire à l'endroit où l'on décrit déjà la commande, le `cwd` et l'`env` :

```jsonc
{
  "plugins": [
    {
      "package": "opencode-acp-provider",
      "options": {
        "agents": [
          {
            "id": "copilot",
            "command": "copilot",
            "args": ["--acp"],
            "session": "reuse"
          },
          {
            "id": "codex",
            "command": "npx",
            "args": ["-y", "@agentclientprotocol/codex-acp"],
            "session": "fresh"
          }
        ]
      }
    }
  ]
}
```

Les deux formes écrivent le même réglage, et `agents[].session` **gagne** sur
`provider.acp-copilot.options.session` : l'entrée d'agent *est* la configuration
par agent. Un agent qui ne dit rien ne publie **aucune** clé `session`, donc une
configuration écrite avant l'existence du champ produit exactement le même
provider qu'avant — et c'est vérifié par un test qui compare les clés publiées, pas
seulement le comportement.

| `agents[].session` | effet |
| --- | --- |
| absent (défaut) | `fresh` — une session ACP par appel de modèle |
| `"fresh"` | idem, explicite |
| `"reuse"` | une session ACP par conversation, delta seul |
| autre valeur | refusé : `options.agents[N].session doit valoir "fresh", "reuse"` |

### L'identifiant du provider

| `agents[].id` | provider publié |
| --- | --- |
| absent | `acp` |
| `"copilot"` | `acp-copilot` |
| `"Mon Agent!"` | `acp-mon-agent` |

Trois règles, et chacune a une raison :

- **Un agent sans `id` garde `acp`.** C'est la compatibilité : une configuration
  écrite avant les agents multiples continue de publier le provider auquel son
  bloc `providers.acp.settings` fait référence.
- **Un `id` nommé est préfixé par `acp-`.** C'est ce qui rend une collision avec
  un provider d'OpenCode improbable : OpenCode livre `openai`, `anthropic`,
  `github-copilot`…, et l'utilisateur peut déclarer les siens. `editor.add`
  **remplace** l'entrée qui porte le même `id` — sans ce préfixe, un agent nommé
  `copilot` remplacerait purement et simplement un provider existant.
- **L'`id` est réduit à `[a-z0-9-]`** (minuscules, espaces et ponctuation
  remplacés par `-`). Un identifiant est tapé après `provider/model`, utilisé
  comme filtre dans le TUI et mis dans une URL : `acp-Mon Agent!` devrait être
  échappé au moins une fois. Un `id` qui ne laisse **aucun** caractère utilisable
  (`"///"`) est **refusé** plutôt que ramené à `acp` : l'utilisateur a demandé un
  nom, et le lui donner par défaut cacherait la faute de frappe derrière une
  configuration qui marche.

### Que faire d'un identifiant en conflit

**L'agent est écarté, et le journal nomme l'identifiant.** Deux cas :

- **Deux agents de la configuration revendiquent le même id** — après
  normalisation, `copilot` et `Copilot` ne font qu'un. Le **premier** gagne,
  l'autre est journalisé. Laisser les deux passer serait pire qu'un doublon :
  `editor.add` remplace, donc `/model` montrerait les modèles du second sous le
  nom du premier — une substitution silencieuse.
- **L'id est déjà pris par un autre provider** (construit-in ou déclaré par
  l'utilisateur dans `providers`). L'agent est écarté. Le renommer
  automatiquement n'est pas une option : « le prochain nom libre » n'est pas
  stable d'un redémarrage à l'autre, donc `/model` changerait d'identifiant à
  chaque provider ajouté. Refuser est le seul comportement déterministe, et le
  message indique quoi faire.

Dans les deux cas les autres agents sont enregistrés normalement, et le journal
termine par `1 agent(s) écarté(s)`.

⚠️ **Un agent en échec n'en bloque pas d'autres**, mais la découverte est
**séquentielle** : le démarrage de N agents est additionnel, pas parallèle. C'est
délibéré — chaque découverte lance un agent qui s'authentifie, et N agents qui
démarrent ensemble au boot sont exactement le pic que `discoveryTimeoutMs` existe
pour éviter. Un agent mort coûte au plus sa borne, une fois.

## Mappings ACP → OpenCode

Relevé de référence sur `copilot --acp` (agent `Copilot` v1.0.88) : 20 valeurs de
catégorie `model` (dont `auto`), 6 niveaux d'effort, 3 modes, 1 option de
permissions.

| Catégorie ACP | Cible OpenCode | Détail |
| --- | --- | --- |
| `model` | **un `Model.Info` par valeur** | `acp/gpt-5.6-terra`, `acp/claude-sonnet-5`… |
| `thought_level` | **un `variant` par valeur** | `settings: { effort: "high" }` → `set_config_option("reasoning_effort")` avant le prompt |
| `mode` | *(rien)* | les modes ACP sont des agents, pas des modèles : hors périmètre pour l'instant |
| `permissions` | *(rien)* | épinglée côté agent ; la politique est dans `allowedTools` |

Le `Model.ID` est **exactement** la valeur ACP : c'est ce que l'adaptateur
renvoie à `set_config_option`, sans table de correspondance.

Le provider s'appelle `acp`, ou `acp-<id>` pour un agent nommé (voir « Plusieurs
agents »), et son `name` est `ACP — <agentInfo.name>`. Son
`package` est une URL `file://` **absolue** vers le module exportant `model`,
calculée depuis `import.meta.url` (`resolvePackageURL` dans `src/plugin.ts`).

Le même module sert **tous** les providers ACP : OpenCode n'appelle qu'une chose
d'un package provider, `model(modelID, settings)`, et rien d'autre n'y porte
l'identité du provider. L'id voyage donc **dans les settings** — le plugin
l'écrit sous la clé `provider`, et `parseSettings` le relit. C'est aussi ce qui
isole deux agents dans `agentKey` : deux providers ne partagent ni process,
ni authentification, ni sessions ACP.

## Réglage par modèle

Les niveaux d'effort viennent de l'inventaire, et il **varie avec le modèle** :
`copilot --acp` ne propose plus `none` pour `claude-sonnet-5`. Sélectionner un
variant devenu invalide échoue donc avec la liste des valeurs acceptées sous le
nez, plutôt que de laisser l'agent refuser une valeur muette. Le rafraîchissement
automatique est la parade, pas encore la règle.

Sans variant sélectionné, aucun `set_config_option` n'est envoyé : l'agent
applique la valeur qu'il annonce lui-même dans `session/new`.

Il n'existe volontairement **pas** de variant `default` : OpenCode interprète cet
id comme « aucun variant » et n'en fusionne pas les `settings`.

## Versions

| Paquet | Version | Pourquoi |
| --- | --- | --- |
| `@opencode/ai` | `2.0.16` | **la version qu'embarque `opencode@2.0.16`**, et non une plus ancienne : notre provider construit un `LanguageModel` et une `Usage` avec *notre* instance, l'hôte les lit avec *la sienne*. Deux instances = deux classes `Usage`, donc un `instanceof` faux côté hôte, qui échoue avec « The provider response ended unexpectedly. » — indiscernable d'une troncature de flux. `test/opencode.test.ts` compare notre version à la dépendance déclarée par `@opencode/plugin` ; `scripts/verify-package.mjs` vérifie que l'URL du champ `package` désigne le **même** fichier que `exports["."]`, donc qu'un seul module est chargé |
| `@opencode/schema` | `2.0.16` | idem — c'est de là que viennent `LLMEvent` et `Usage` |
| `@opencode/plugin` | `2.0.16` | **en `devDependencies`** : au chargement, c'est l'hôte qui le fournit. Sa version suit celle du CLI, pas celle de `@opencode/ai` |
| `effect` | `4.0.0-rc.112` | release candidate, épinglée |
| `@agentclientprotocol/sdk` | `1.5.0` | le protocole ACP |

⚠️ Le `PLAN.md` référence `@opencode/plugin@2.0.3` : ses types exposent un
domaine `catalog` que le serveur `2.0.16` **n'implémente pas** (son `Context`
expose `provider` et `model`). C'est `2.0.16` qui est épinglé ici, parce que
c'est la version du serveur qui charge le plugin.

### Comptage de tokens : pourquoi l'interface affiche `2/24`

Le tour de recette affichait `tokens=2/24` alors que l'agent, appelé
directement, déclare ~15 000 tokens d'entrée. **Ce n'est pas une perte** : c'est
la répartition du cache.

Relevé réel sur `copilot --acp` v1.0.88, avec la sonde `verify:real` :

```
usage: Usage input=15604 output=43 cacheWrite=15601
```

`inputTokens` porte bien **toute** la fenêtre reçue. L'interface affiche le
`nonCachedInputTokens` — le reste est du `cacheWrite`, que l'agent paie une fois
et qu'OpenCode ne recompte pas à chaque tour. La preuve que le prompt n'est pas
tronqué est directe : en ajoutant ~4 000 tokens au système, `inputTokens`
**augmente** d'autant, et le `nonCached` ne bouge pas.

`test/prompt-fidelity.test.ts` verrouille le reste : le prompt est comparé
**caractère par caractère** à celui que le faux agent a réellement reçu sur le
fil (`FAKE_PROMPT_FILE`), pour une requête réaliste — système multi-parties,
trois outils avec schémas JSON, transcript avec appel et résultat d'outil.

## Développement

```bash
bun install
bun test            # 330 tests, dont la chaîne ACP complète contre test/fake-acp.ts
bun run typecheck   # tsc --noEmit, strict + noUncheckedIndexedAccess
npm run verify:package   # exécute le paquet pour vérifier son contrat (Node)
npm run verify:real copilot --acp    # sonde hors suite : exige un agent installé
npm run verify:resume copilot --acp  # idem, `session: "reuse"` mesuré contre `fresh`
```

### `verify:package` — le contrat, vérifié **par exécution**

```bash
npm run verify:package    # ou : node scripts/verify-package.mjs
```

Inspiré du `prepack` d'`opencode-acpx` (MIT). Un point d'entrée qui n'exporte
pas ce qu'OpenCode appelle, ou un champ `package` qui ne pointe sur rien, ne
produit **aucune** erreur au chargement : le serveur importe le module, ne trouve
pas `model`, et le premier chat échoue. Ce script **importe réellement** les
deux points d'entrée et vérifie :

- `default.setup` est une fonction, et le plugin a un `id` ;
- `model` est une fonction ;
- l'URL calculée par le plugin pour le champ `Provider.Info.package` est un
  `file://` **absolu** pointant vers un fichier qui **existe**, et désigne le
  **même** module que `exports["."]` (donc une seule instance chargée) ;
- les fichiers déclarés dans `exports` existent.

Il sort avec un code **non nul** et un message nommant le champ fautif
(`default.setup`, `model`, `Provider.Info.package`, `exports["."]`…). Il est
branché sur `prepack`, donc il tourne avant toute publication.

⚠️ Il s'exécute sous **Node**, pas sous Bun : `prepack` tourne chez qui publie,
dans une CI qui n'a pas forcément Bun. Node efface les types depuis la 22.6 mais
ne réécrit pas les spécificateurs — d'où `scripts/resolve-ts-extensions.mjs`, un
crochet de résolution de vingt lignes qui mappe `./x.js` vers `./x.ts` **seulement
si le fichier existe**. C'est aussi la raison pour laquelle `AcpAgentError`
déclare son champ `subject` explicitement : une « parameter property » est du
TypeScript que l'effacement de types de Node ne sait pas traiter.

`test/publish.test.ts` ne teste que des fonctions pures — `src/core/publish.ts`
n'importe ni `@opencode/plugin`, ni `effect`, ni le SDK, et un test le vérifie.
C'est ce découpage qui rend l'inventaire testable sans lancer OpenCode.
