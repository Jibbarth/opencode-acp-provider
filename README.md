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
| P4 — permissions fines, `session/cancel`, erreurs §8 | à faire |
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

- **Un seul agent par instance.** Le plugin enregistre le **premier** de la liste
  `agents` ; les suivants sont journalisés et ignorés. La route porte un
  `provider` fixe (`acp`), donc deux agents ne pourraient pas cohabiter.
- **`auto` est filtré.** C'est une pseudo-valeur : l'agent choisit le modèle à
  chaque tour sans le dire, donc un `Model.Info` serait faux (limites, coût) sans
  jamais le signaler. Voir `PSEUDO_MODEL_IDS` dans `src/core/publish.ts`.
- **`allowedTools` est dégradé en interrupteur.** `["*"]` autorise tout le natif,
  toute autre liste se comporte comme « tout refuser » : la demande de
  permission ACP ne porte pas toujours le nom de l'outil. C'est le choix
  *fail-safe* du §7.4, pas un oubli.
- **`session: "reuse"` n'est pas implémenté.** Le défaut est `"fresh"` : une
  session ACP par requête (`PLAN.md` §10).
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
| `agents` | `AgentConfig[]` | `[{ "command": "copilot", "args": ["--acp"] }]` | Les agents à découvrir (le premier est enregistré) |
| `refreshMs` | `number` | `60000` | Délai minimum entre deux redécouvertes ; `0` désactive |

`AgentConfig` :

| Champ | Type | Rôle |
| --- | --- | --- |
| `command` | `string` **obligatoire** | La commande à lancer |
| `args` | `string[]` | Les arguments (`["--acp"]`) |
| `cwd` | `string` | Répertoire de travail de l'agent (le process est *partagé* entre toutes les requêtes — cf. `PLAN.md` §9bis) |
| `env` | `Record<string,string>` | Variables **ajoutées** à celles du serveur |
| `allowedTools` | `string[]` | `["*"]` = tout autoriser ; absent = tout refuser (§7.4) |
| `limits` | `{ context, output }` | Limites annoncées dans `/model` |
| `id` | `string` | Étiquette pour les journaux ; défaut : la commande |

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

Le provider s'appelle `acp` et son `name` est `ACP — <agentInfo.name>`. Son
`package` est une URL `file://` **absolue** vers le module exportant `model`,
calculée depuis `import.meta.url` (`resolvePackageURL` dans `src/plugin.ts`).

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
| `@opencode/ai` | `2.0.3` | celle qu'embarque `opencode@2.0.16` ; épinglée pour que le smoke test casse bruyamment en cas de dérive |
| `@opencode/schema` | `2.0.3` | idem |
| `@opencode/plugin` | `2.0.16` | **en `devDependencies`** : au chargement, c'est l'hôte qui le fournit. Sa version suit celle du CLI, pas celle de `@opencode/ai` |
| `effect` | `4.0.0-rc.112` | release candidate, épinglée |
| `@agentclientprotocol/sdk` | `1.5.0` | le protocole ACP |

⚠️ Le `PLAN.md` référence `@opencode/plugin@2.0.3` : ses types exposent un
domaine `catalog` que le serveur `2.0.16` **n'implémente pas** (son `Context`
expose `provider` et `model`). C'est `2.0.16` qui est épinglé ici, parce que
c'est la version du serveur qui charge le plugin.

## Développement

```bash
bun install
bun test            # 211 tests, dont la chaîne ACP complète contre test/fake-acp.ts
bun run typecheck   # tsc --noEmit, strict + noUncheckedIndexedAccess
bun run verify:real copilot --acp   # sonde hors suite : exige un agent installé
```

`test/publish.test.ts` ne teste que des fonctions pures — `src/core/publish.ts`
n'importe ni `@opencode/plugin`, ni `effect`, ni le SDK, et un test le vérifie.
C'est ce découpage qui rend l'inventaire testable sans lancer OpenCode.
