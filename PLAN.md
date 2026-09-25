# Plan — `opencode-acp-provider`

Exposer un agent ACP (codex, copilot, gemini, qwen…) comme **model provider OpenCode**,
afin de l'utiliser dans l'interface TUI d'OpenCode.

- Cible d'implémentation : `/home/barth/Projects/opencode-acp-provider` (dossier vide, non versionné)
- Versions de référence vérifiées : `opencode v2.0.16`, `@opencode/ai 2.0.3`, `@opencode/plugin 2.0.3`, `effect 4.0.0-rc.112`, `bun 1.3.14`

---

## 0. Faisabilité — validée par exécution réelle

Avant de planifier, chaque hypothèse a été testée dans un REPL `bun` contre
`~/.config/opencode/node_modules`. Résultats :

| Hypothèse | Résultat |
| --- | --- |
| `providers.<id>.package` accepte un module arbitraire | ✅ `Provider.Info.package: Schema.String` (aucun enum) ; doc : « an absolute `file://` URL for a local package » |
| `Route.make` accepte un `transport` non-HTTP | ✅ surcharge `MakeTransportInput` (`route/client.d.ts`) |
| `Transport.execute` peut émettre ses propres frames | ✅ testé : transport custom → `Stream<Frame>` |
| Le pipeline réduit nos frames en `LLMEvent` valides | ✅ testé : `["step-start","text-start","text-delta","text-end","step-finish","finish"]` |
| Une séquence d'événements mal formée est rejetée | ✅ `AI.Error: The provider response ended unexpectedly.` → **le mapping doit être exact** |

Code qui a produit la preuve :

```ts
const route = make({
  id: "acp", provider: "acp", protocol,
  endpoint: E.path("/", { baseURL: "http://acp.local" }),  // placeholder
  auth: A.none,                                             // stdio ⇒ pas d'auth
  transport,                                                // ← nôtre
  compact: undefined,
})
```

⚠️ Le placeholder `http://acp.local` est requis : le core rend l'URL dans
`compileRequest` (accès à `request.model.provider`) même si le transport l'ignore.

---

## 1. Décision d'architecture — Option B

**Choix : package provider custom avec `Transport` ACP sur stdio.**

L'agent et le provider tournent dans le **même processus Bun** : le plugin est chargé par
le serveur OpenCode, et le champ `package` est importé par ce même serveur. Communication
directe, aucun port, aucun proxy.

### Comparatif honnête B vs A

| | **B — Transport natif** | A — Bridge HTTP |
| --- | --- | --- |
| Client ACP (JSON-RPC stdio) | identique | identique |
| Code en plus | 0 | serveur HTTP + encodage SSE + mapping format OpenAI (~200 l.) |
| Coût par token | nul | 2 sérialisations + 1 saut loopback |
| Cycle de vie process | `Scope` natif → kill propre | à gérer (idle timeout, ports, collisions) |
| `session/cancel` | direct | indirect |
| Erreurs / retry hook | ⚠️ **dégradé** (voir §8) | ✅ statut HTTP réel |
| Réduction `LLMEvent` | à nous écrire, **strictement validée** | déjà faite par le runtime |
| Couplage | ⚠️ internals `@opencode/ai` + `effect` RC | API publique seulement |

Le code client ACP est identique dans les deux cas : B n'ajoute pas de couche, elle évite
celle de A. Le vrai coût de B n'est pas le code, c'est le **couplage** aux internals.

**Mitigation : l'architecture en couches du §2.** Le client ACP et le cœur métier ne
contiennent **aucun import** de `@opencode/ai` ni d'`effect`. L'adaptateur
`opencode-transport` est une coquille mince (~150 l.) au-dessus. Si les internels bougent,
on ne réécrit que cette coquille — ou on bascule sur l'adaptateur HTTP, déjà écrit.

**Pinning :** versions exactes de `@opencode/ai` et `effect` dans `package.json` + un test de fumée
qui échoue bruyamment si le contrat change.

---

## 2. Architecture en couches — le cœur est portable

> ⚠️ **§2 révisé après recherche** : un SDK officiel existe et couvre toute la couche `acp/`.
> Voir **§2.0**. L'architecture en couches tient, mais la couche ACP devient une coquille
> d'une centaine de lignes au lieu de ~400.

**Le contrat central du projet est `AsyncIterable<AcpEvent>`.** Tout ce qui est en dessous
parle ACP, tout ce qui est au-dessus est un adaptateur interchangeable.

```
   ┌──────────────────────────────┐  ┌──────────────────────────┐  ┌──────────────┐
   │ adapters/opencode-transport   │  │ adapters/openai-http      │  │ adapters/cli  │
   │  Effect Transport + Protocol  │  │  serveur /v1 SSE          │  │  acp-run      │
   │  → LLMEvent   (~150 l.)       │  │  → OpenAI SSE   (~150 l.) │  │  (~60 l.)     │
   │  ⚠️ couplé aux internals      │  │  ✅ portable               │  │  ✅ portable  │
   └───────────────┬──────────────┘  └────────────┬─────────────┘  └──────┬───────┘
                   │                            │                       │
   ┌───────────────┴────────────────────────────┴───────────────────────┴───────┐
   │  core/   —  AUCUNE dépendance à un framework                                │
   │   • prompt.ts   construction du prompt (système + catalogue d'outils +       │
   │                 transcript + contrat JSON)   ← §7.3, partagé par tous        │
   │   • normalize   modèle commun de requête (system / tools / messages)        │
   │   • models.ts   découverte d'inventaire via configOptions (§5)                │
   └───────────────────────────────┬─────────────────────────────────────────────┘
                                   │
   ┌───────────────────────────────┴─────────────────────────────────────────────┐
   │  acp/   —  protocole ACP, zéro import de quoi que ce soit                   │
│   │   ├── agent.ts          #   spawn + ndJsonStream + client() + handlers
   └─────────────────────────────────────────────────────────────────────────────┘
```

### 2.0 Le SDK officiel — `@agentclientprotocol/sdk`

**Il existe et il est très complet.** Package npm `@agentclientprotocol/sdk`, **v1.5.0**,
édité par l'équipe ACP (repository : `agentclientprotocol/typescript-sdk`).

Il fournit **les deux côtés** du protocole (agent *et* client). Côté client, ce qu'il couvre :

| Besoin | API du SDK | Lignes économisées |
| --- | --- | --- |
| Framing JSON-RPC NDJSON sur stdio | `acp.ndJsonStream(input, output)` | ~150 |
| Client typé, enregistrement de handlers | `acp.client({name}).onRequest(method, fn).connectWith(stream, fn)` | ~80 |
| Cycle de vie de session | `ctx.buildSession(cwd).withSession(s => …)`, `withMcpServer()`, `withAdditionalDirectories()` | ~150 |
| Boucle prompt ↔ updates | `session.prompt(...)`, `session.nextUpdate()` → `{kind:"update"\|"stop"}`, `session.readText()` | ~100 |
| Permissions | `.onRequest(acp.methods.client.session.requestPermission, fn)` | ~80 |
| Types du protocole | `schema/schema.json` + types générés | ~120 |
| `initialize`, `set_config_option`, `cancel` | `ctx.request(acp.methods.agent.…)` typé par méthode | ~60 |

**Validé en exécution réelle** contre `copilot --acp` (voir `probe/sdk-inspect.mjs`) :
initialize, session, inventaire, prompt, permission, `stopReason` et `usage` — **sous Node
ET sous Bun**, ce qui compte puisque le provider tourne dans le runtime Bun d'OpenCode.

#### Ce que ça change

- La couche `acp/` du projet passe de **~400 lignes à ~120** de glue.
- Le typage du protocole n'est plus à notre charge.
- **Le transport devient interchangeable** : `ndJsonStream` (stdio) par défaut, mais le SDK
  exporte aussi `experimental/ws-client` (`createWebSocketStream`) et
  `experimental/http-client`. Si un agent expose un jour ACP sur WebSocket/HTTP, on change
  **une fonction** — le reste du code est inchangé. Cela confirme la décision stdio (§13, Q5).
- Il y a même des exemples `ws-client` / `http-client` / `http-server` dans le SDK.

#### Ce que ça introduit

- **`zod` est un `peerDependency`** (`^3.25 || ^4`) → à installer explicitement.
- Dépendance externe supplémentaire à pinner (comme `@opencode/ai`).
- `AgentSideConnection` / `ClientSideConnection` sont **dépréciés** au profit des API fluides
  `client()` / `agent()` : ne pas s'appuyer sur les classes anciennes.

#### Verdict

**On utilise le SDK.** Écrire notre propre client JSON-RPC serait du gaspillage. Le cœur
`core/` (prompt, parse, modèles) reste entièrement à nous — c'est là qu'est la vraie valeur.

### 2.1 L'API du cœur (le point de bascule)

```ts
// core/types.ts
export type AcpEvent =
  | { type: "text";    text: string }
  | { type: "thought"; text: string }
  | { type: "tool";    id: string; name: string; input: unknown; status: string; output?: unknown }
  | { type: "plan";    entries: readonly PlanEntry[] }
  | { type: "usage";   input?: number; output?: number }
  | { type: "done";    stopReason: "end_turn" | "max_tokens" | "refusal" | "cancelled" }
  | { type: "error";   message: string }

export interface AcpAgent {
  readonly info: { name: string; version: string }
  models(): Promise<readonly AcpModel[]>
  open(options?: { cwd?: string; signal?: AbortSignal }): Promise<AcpSession>
}

export interface AcpSession {
  setModel(modelID: string): Promise<void>
  setOption(configId: string, value: string): Promise<void>
  /** Le SEUL point que les trois adaptateurs ont en commun. */
  prompt(request: NormalizedRequest, options?: { signal?: AbortSignal }): AsyncIterable<AcpEvent>
  close(): Promise<void>
}
```

`core/prompt.ts` prend une `NormalizedRequest` **independante d'OpenCode** :

```ts
interface NormalizedRequest {
  system: readonly string[]
  tools: readonly { name: string; description: string; schema: unknown }[]
  messages: readonly NormalizedMessage[]   // { role, text } | { role:"tool", name, output }
  maxOutputTokens?: number
  thinkingLevel?: string
}
```

L'adaptateur OpenCode convertit `LLMRequest` → `NormalizedRequest` ;
l'adaptateur HTTP convertit le corps OpenAI → `NormalizedRequest`. **La logique métier
(construction du prompt, parsing de la sortie JSON, politique de permissions) n'existe
qu'une seule fois.**

### 2.2 Que reste-t-il si on quitte OpenCode ?

| Composant | Lignes | Portable ? |
| --- | --- | --- |
| `acp/` (glue au SDK : spawn + stream + handlers) | ~120 | ✅ totalement |
| `core/` (prompt, parse, models, events) | ~300 | ✅ totalement |
| `adapters/openai-http` | ~150 | ✅ réutilisable tel quel |
| `adapters/cli` | ~60 | ✅ |
| `adapters/opencode-transport` (Transport + Protocol + LLMEvent) | ~150 | ❌ **le seul à jeter** |
| `plugin.ts` | ~120 | ❌ **le seul à jeter** |

Soit **~800 lignes dont ~630 survivent**, et les 270 à jeter sont eux-mêmes
remplaçables par l'adaptateur HTTP en ~150 lignes.

### 2.3 Pourquoi le bridge HTTP n'est pas un plan B, c'est un **outiller**

Les deux ne sont pas exclusifs, ils se cumulent :

- **Débogage** : `curl` contre le bridge pour voir ce que l'agent produit vraiment.
- **Partage d'un seul agent** entre opencode, Zed, Claude Code, etc.
- **Compatibilité large** : tout client OpenAI-compatible (Cline, Continue, Aider…)
  peut consommer l'agent ACP sans installer de plugin.
- ** filet de sécurité** : si les internals `@opencode/ai` bougent (§1), on bascule
  `package` sur `@opencode/ai/providers/openai-compatible` + `baseURL` sans réécrire le cœur.

Et le cas le plus simple reste ouvert : **si l'alternative est un autre client ACP** (Zed,
Gemini CLI), il n'y a rien à écrire — on pointe le client ACP sur l'agent directement.

### 2.4 Structure du dépôt

```
opencode-acp-provider/
├── package.json
├── tsconfig.json
├── src/
│   ├── acp/                  # couche 3 — glue sur le SDK officiel (~120 l., cf. §2.0)
│   │   ├── agent.ts          #   spawn + ndJsonStream + client() + handlers
│   │   ├── transport.ts      #   ndJsonStream | ws-stream | http-stream  (§2.0)
│   │   └── policy.ts         #   config d'options (allow_all, effort, modèle)
│   ├── core/                 # couche 2 — logique métier partagée, 100% à nous
│   │   ├── types.ts          #   AcpEvent / AcpAgent / AcpSession / NormalizedRequest
│   │   ├── agent.ts          #   AcpAgent construit sur le SDK
│   │   ├── prompt.ts         #   §7.3 — construction du prompt + contrat de sortie
│   │   ├── parse.ts          #   extraction/validation de la sortie JSON de l'agent
│   │   └── models.ts         #   §5 — inventaire via configOptions
│   ├── adapters/             # couche 1 — interchangeables
│   │   ├── opencode-transport.ts   # Effect Transport + Protocol + LLMEvent
│   │   ├── opencode-protocol.ts    #   LLMEvent ↔ AcpEvent
│   │   ├── openai-http.ts          #   serveur /v1/chat/completions (SSE)
│   │   └── cli.ts                  #   binaire `acp-run`
│   ├── index.ts              # point d'entrée provider  → exporte `model`
│   ├── plugin.ts             # point d'entrée plugin OpenCode
│   └── settings.ts
├── bin/
│   └── acp-run.ts
├── probe/                    # sondes ACP réutilisables (inspect / switch-option / sdk-inspect)
└── test/
    ├── smoke.test.ts         # contrat Route/Transport vs @opencode/ai pinné
    └── fake-acp.ts           # agent ACP factice (stdio)
```

---

## 3. Contrats

### 3.1 `package` provider — minimalisme

`@opencode/ai/dist/provider-package.d.ts` :

```ts
interface Definition<ProviderSettings, Options, Compact> {
  readonly model: (modelID: string, settings: ProviderSettings) => LanguageModel<Options, Compact>
}
```

`src/index.ts` :

```ts
import type { LanguageModel } from "@opencode/ai/schema/index"
import { makeRoute } from "./route"
import type { Settings } from "./settings"

export const model = (modelID: string, settings: Settings): LanguageModel => {
  const route = makeRoute(settings)
  return route.model({ id: modelID })
}
```

### 3.2 `Settings` (JSON plat — `ProviderPackage.Settings` interdit les callbacks)

```ts
export interface Settings {
  command: string              // "copilot"
  args?: string[]              // ["--acp"]
  cwd?: string
  env?: Record<string, string>
  tools?: "none" | "all"       // "none" = mode cerveau brut (défaut)
  session?: "reuse" | "fresh"
  systemSuffix?: string
}
```

Transmis via `providers.<id>.settings` ou, par agent, via `models.<id>.settings` dans le plugin.

### 3.3 `Transport`

```ts
export const transport: Transport<Body, AcpPrepared, string> = {
  id: "acp/stdio",
  prepare: (input) => Effect.succeed(buildPromptParams(input.body, input.request)),
  execute: (prepared, _req, _rt, _opts) =>
    Effect.gen(function* () {
      const session = yield* AcpSession.acquire(prepared)  // spawn + initialize + session/new
      const frames  = yield* session.promptFrames(prepared)
      return { frames, complete: session.release }
    }),
}
```

`execute` est typé `Effect<…, AIError, Scope>` : la fin du `Scope` (stream interrompu,
`session.cancel`) tue le process. `TransportExecution.http` est omis → aucun faux contexte HTTP.

### 3.4 `Protocol`

```ts
const protocol = Protocol.make({
  id: "acp",
  body: { schema: PromptBody, from: (request) => Effect.succeed(flatten(request)) },
  stream: {
    event: Protocol.jsonEvent(AcpNotification),  // une ligne JSON stdout
    initial: () => ({ text: null, reasoning: null, step: 0, toolcalls: new Map() }),
    step: (state, ev) => Effect.succeed(reduce(state, ev)),
    onHalt: (state) => Effect.succeed(closeOpenBlocks(state)),
  },
})
```

---

## 4. Mapping ACP → `LLMEvent`

Séquence **obligatoire** (vérifiée) : `step-start` → (`text-start` → `text-delta`* → `text-end` | `reasoning-*` | `tool-*`) → `step-finish` → `finish`.
`tout` doit être fermé, sinon `The provider response ended unexpectedly.`

| Notification ACP (`session/update`) | `LLMEvent` |
| --- | --- |
| `agent_message_chunk` (contenu `text`) | ouvre `text-start{id}` si fermé ; `text-delta{id, text}` |
| `agent_thought_chunk` | `reasoning-start{id}` / `reasoning-delta{id,text}` / `reasoning-end{id}` |
| `tool_call` (statut `pending`/`in_progress`) | `tool-input-start` + `tool-input-delta`(streaming de `rawInput`) + `tool-input-end`, puis `tool-call{ id, name, input, providerExecuted }` |
| `tool_call_update` → `completed`/`failed` | `tool-result{ id, name, result: {type:"text"\|"error", value} }` |
| `tool_call_update` → `diff` | `tool-call.locations` / contenu `rawOutput` |
| `plan` | `reasoning-*` (ou tool `plan` dédié) |
| `config_option_update` | ignoré côté `LLMEvent` ; déclenche `ctx.provider.reload()` (§5) |
| `usage_update` | compteur cumulé ; `finish.usage` à la fin du tour (voir ci-dessous) |
| `session_info_update` | ignoré (métadonnées de session) |
| `available_commands_update` | ignoré, ou exposé comme commandes OpenCode (§6) |
| `session/prompt` terminé | `step-finish` puis `finish` (voir §5 pour `usage`) |

`finish.reason.normalized` : `stopReason` ACP → `"stop"` / `"tool-calls"` (selon config) / `"error"`.
`step-finish` et `finish` portent tous deux `reason` + `index`.

### 4.1 `usage` — mesuré, ça marche

`PromptResponse` transporte un `usage` complet, et une notification `usage_update` le met à jour
en cours de tour. Relevé réel sur `copilot --acp` :

```json
{ "stopReason": "end_turn",
  "usage": { "inputTokens": 15076, "outputTokens": 13, "totalTokens": 15089,
             "thoughtTokens": 0, "cachedReadTokens": 0, "cachedWriteTokens": 15073 } }
```

Le mapping vers `Usage` d'OpenCode est donc **direct** : `inputTokens`/`outputTokens`,
et `cachedReadTokens`/`cachedWriteTokens` alimentent les paliers de `Cache` du schéma
`Model.Info.cost` (§6). Le risque « pas de comptage des tokens » est **levé**.

**`providerExecuted: true`** — le champ existe sur `tool-call`, `tool-result` et `tool-error`
(`schema/events.d.ts`) et est déjà consommé par les protocols de lowering
(`protocols/anthropic-messages.js:657`, `protocols/open-responses.js:505`). C'est le mécanisme
officiel pour « le provider a déjà exécuté l'outil ». **À spike-er** (§11, P3) : vérifier que la
boucle agent du core ne ré-exécute pas ces appels.

---

## 5. `configOptions` ACP → `/model` et variants

**Vérifié empiriquement** contre `copilot --acp` (agent `Copilot` v1.0.88), cf. §5.1.

`session/new` renvoie `configOptions` ; `session/set_config_option` les modifie.
Catégories (`ConfigOptionCategory`) :

| Catégorie ACP | Cible OpenCode |
| --- | --- |
| `model` | **un modèle OpenCode par valeur** → `acp-copilot/claude-sonnet-5`… |
| `thought_level` | **variants** du modèle (effort / reasoning) |
| `model_config` | **variants** (taille de contexte, compromis vitesse/qualité) |
| `mode` | **agents OpenCode** (build ↔ `#agent`, plan ↔ `#plan`…) |
| *(hors spec)* `permissions` | épinglé à `off` en mode cerveau brut (sécurité, §7.4) |

### 5.1 Relevé réel — `copilot --acp`

`initialize` :

```json
{ "protocolVersion": 1,
  "agentCapabilities": { "loadSession": true,
    "mcpCapabilities": { "http": true, "sse": true },
    "promptCapabilities": { "image": true, "audio": false, "embeddedContext": true },
    "sessionCapabilities": { "close": {}, "list": {} } },
  "agentInfo": { "name": "Copilot", "version": "1.0.88" },
  "authMethods": [ { "id": "copilot-login", "_meta": { "terminal-auth": {...} } } ] }
```

`session/new` → 4 options, réparties ainsi :

```
[mode]           id=mode                current=#agent   values=[#agent, #plan, #autopilot]
[model]          id=model               current=gpt-5.6-terra
                 values=[auto, gpt-5.6-terra, gpt-5.6-luna, gpt-5.4, gpt-5.4-mini,
                         gpt-5.3-codex, gpt-5-mini, claude-sonnet-5, claude-haiku-4.5,
                         mai-code-1.1-flash, gemini-3.8-flash, gemini-3.7-flash,
                         gemini-3.6-flash, gemini-3.5-flash, grok-4.5, kimi-k3,
                         kimi-k2.7-code, gpt-6-luna, grok-4.6, grok-4.7]
[thought_level]  id=reasoning_effort    current=medium    values=[none, low, medium, high, xhigh, max]
[permissions]    id=allow_all           current=off       values=[on, off]
```

Le champ `modes` (API v1 héritée) est aussi présent, avec `currentModeId`.

**Changement de modèle — testé et fonctionnel :**

```
session/set_config_option { sessionId, configId: "model", value: "claude-sonnet-5" }
  → model = claude-sonnet-5   (la réponse renvoie TOUT l'état, comme le spécifie la doc)
session/set_config_option { sessionId, configId: "reasoning_effort", value: "max" }
  → effort = max, model inchangé
session/set_config_option { configId: "model", value: "pas-un-modele" }
  → ERREUR JSON-RPC -32602, "Invalid model", avec la liste des valeurs supportées
```

### 5.2 Conséquences pour la conception

- **L'inventaire est dynamique** : 19 valeurs au premier `session/new`, **20** après un
  `set_config_option`. L'agent peut ajouter/retirer des modèles. Il faut donc gérer la
  notification `config_option_update` et appeler `ctx.provider.reload()` — un inventaire figé
  au démarrage serait faux.
- **`auto`** est une pseudo-valeur : à exposer telle quelle ou à filtrer.
- Les identifiants de mode sont des **URL** (`https://agentclientprotocol.com/...#agent`) —
  à raccourcir pour l'affichage côté OpenCode.
- `mcpCapabilities.http: true` ⇒ l'agent accepte des serveurs **MCP sur HTTP/SSE** dans
  `session/new.mcpServers`. Cela raviverait la piste B du §7.2 (exposer les outils OpenCode à
  l'agent), mais elle reste **bloquée** : l'API plugin n'a toujours aucun moyen d'**invoquer**
  un outil OpenCode. À réexaminer si cette API évolue.
- Le changement de modèle doit être appliqué **avant** `session/prompt`, dans `transport.execute`.

Découverte de l'inventaire : le plugin lance l'agent, appelle `initialize` + `session/new`,
lit `configOptions`, puis publie un `Model.Info` par valeur de catégorie `model`. Puis
`ctx.provider.reload()`.

---

## 6. Plugin — enregistrement du provider

```ts
import { Plugin, Provider, Model } from "@opencode/plugin"
import { pathToFileURL } from "node:url"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const PACKAGE = pathToFileURL(resolve(here, "../dist/index.js")).href  // chemin absolu

export default Plugin.define({
  id: "opencode-acp-provider",
  async setup(ctx) {
    const agents = ctx.options.agents as AgentConfig[]   // via opencode.jsonc
    const inventory = await discover(agents)            // spawn + initialize + configOptions

    const registration = await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          ...Provider.Info.empty(Provider.ID.make("acp")),
          name: "ACP",
          activation: "enabled",
          package: PACKAGE,
        },
        models: inventory.models,
      })
    })
    return () => registration.dispose()   // cleanup
  },
})
```

`Provider.Info.empty(id)` fournit `id`/`name`/`activation` ; on ajoute `package`.
`package` pointe sur un **chemin absolu calculé depuis `import.meta.url`** → portable, et le même
spécifier `file://` garantit l'identité de module entre plugin et provider (utile si on veut
partager un registre in-process, §9).

Config :

```jsonc
{
  "plugins": [{ "package": "./opencode-acp-provider", "options": {
    "agents": [
      { "id": "copilot", "command": "copilot", "args": ["--acp"] },
      { "id": "codex",   "command": "npx", "args": ["-y", "@agentclientprotocol/codex-acp"] }
    ]
  }}]
}
```

---

## 7. Le problème central : qui exécute les outils ?

En ACP v1, **l'agent exécute ses propres outils** ; le client ne fait qu'*afficher* et *autoriser*.
OpenCode fait l'inverse : le modèle **émet** des `tool-call` et **OpenCode les exécute**.

### 7.1 Le trou du mode « cerveau brut » naïf

Si on bloque les outils de l'agent ACP et qu'on ne lui transmet pas d'outils, l'agent répond en
texte → on n'émet que `text-delta` + `finish` → **la boucle OpenCode ne voit aucun `tool-call`
et termine le tour. Aucun outil OpenCode n'est jamais déclenché.**

Bloquer les outils ACP ne suffit donc pas : il faut que l'agent **propose** des appels d'outils
OpenCode, sans les exécuter lui-même.

### 7.2 Les trois pistes évaluées

| Piste | Verdict | Raison |
| --- | --- | --- |
| **A. Pont à sortie structurée** | ✅ **retenu** | universel, aucune coopération de l'agent requise |
| B. Exposer les outils OpenCode comme serveur MCP à l'agent (`session/new.mcpServers`) | ❌ bloqué | l'API plugin n'expose que `tool.list` / `tool.transform` / `tool.reload` — **aucun moyen d'invoquer un outil** |
| C. Faire exécuter fs/terminal par le client ACP (`fs/*`, `terminal/*`) | ❌ mort en amont | l'RFD **ACP v2 supprime cette surface** : « it has not been widely adopted ». Et les agents ne l'utilisent pas. |

> Note : B est pourtant la direction annoncée d'ACP v2 (« expose a special MCP server to the
> agent »). Elle resterait la plus élégante le jour où l'API plugin exposera l'invocation d'outils.

### 7.3 Mécanisme retenu — pont à sortie structurée

`body.from(request)` construit le prompt ACP à partir de la requête OpenCode :

1. **Système** : `request.system` (donc AGENTS.md, instructions, skills injectées) + un contrat
   de sortie strict.
2. **Catalogue d'outils** : les `request.tools` avec leurs **vrais noms et JSON schemas**.
3. **Transcript** : les `request.messages` rendus en texte, y compris les résultats d'outils.
4. **Contrat de sortie** : « Réponds **uniquement** par un objet JSON, sans texte autour :
   `{ "type":"text", "text":"…" }` ou `{ "type":"tool", "name":"<un des outils ci-dessus>",
   "arguments":{…} }` ».

Côté `protocol.ts`, on parse cette sortie :

- `{type:"text"}` → `text-start` / `text-delta` / `text-end`
- `{type:"tool"}` → `tool-input-start` / `tool-input-delta` / `tool-input-end` puis
  `tool-call{ id, name, input }` — **sans `providerExecuted`**, donc la boucle OpenCode
  l'exécute réellement (permissions, snapshots, undo, journalisation).
- Au tour suivant, le message `role:"tool"` de `request.messages` contient le résultat → on le
  replie dans le prompt ACP.

**Avantage clé :** les noms d'outils sont imposés par notre JSON, donc il n'y a **aucun problème
de mapping** entre les noms d'outils ACP (explicitement « opaques ») et ceux d'OpenCode.

> ✅ **Validé empiriquement.** Sur `copilot --acp`, l'agent a obéi au contrat :
> pour l'instruction « réponds uniquement par un objet JSON `{"type":"text",…}` », il a
> produit exactement `{"type":"text","text":"pong"}`, streamé caractère par caractère,
> puis `stopReason: end_turn`. Le taux de conformité reste à mesurer sur d'autres agents
> et sur des prompts plus complexes (Q13.3), mais le principe est démontré.

**Coût :** du prompt-shaping (l'agent gaspille des tokens à formater du JSON), et il faut gérer
une sortie malformée (réparation/répétition bornée).

### 7.4 Empêcher l'agent d'agir tout de même

En parallèle du mécanisme 7.3, on neutralise sa surface d'outils natifs :

1. **Réponse systématique à `session/request_permission`** → `optionId` de type `reject_*`.
   Demandé à chaque outil ⇒ blocage effectif même si l'agent ignore les instructions.
2. **Réduction de la surface au `spawn`** quand l'agent le supporte :
   - copilot : `--available-tools` (« Only these tools will be available »)
   - configurable via `settings.tools: "none" | "all"`.
3. **Instruction** : « n'appelle aucun outil natif » — filet de sécurité, pas garantie.

### 7.5 Ce qu'on forwarde

| Élément OpenCode | Transmission à l'agent ACP |
| --- | --- |
| `request.system` (AGENTS.md, instructions) | ✅ inline en tête de prompt — ACP n'a pas de champ « system » |
| `request.tools` (+ JSON schemas) | ✅ cœur du mécanisme 7.3 |
| `request.messages` (transcript, résultats d'outils) | ✅ rendu texte |
| **Skills** | ⚠️ pas d'invocation possible ; seul le texte déjà injecté dans `system` profite |
| **Serveurs MCP OpenCode** | ✅ `session/new.mcpServers` — lus via `ctx.mcp.list()`, passés via le registre in-process (§9) |

---

## 8. Erreurs, retries, cancellation — limites identifiées

Trois frictions réelles, à documenter et contourner :

**(a) `TransportError.transport` est un union fermé `["http", "websocket"]`** (`schema/errors.d.ts`).
Pas de valeur `stdio` ⇒ impossible de signaler proprement une panne de pipe. Contournement :
échouer avec `ProviderInternalError` / `UnknownProviderError`, qui reste dans le même union
`AIError` mais sans `status`.

**(b) Le hook `session.hook("retry")` raisonne en HTTP** : `event.error.status === 429`,
`error.type === "provider.invalid-request"`. Conséquence : **pas de retry sur 429/rate-limit ACP**.
À compenser côté plugin : on mape les erreurs ACP connues (rate limit, quota) vers
`RateLimitError` / `QuotaExceededError` quand l'agent les signale dans `_meta` ou son texte.

**(c) `http.request` / `http.response` / `experimental.ws.*` ne se déclencheront jamais.**
Observableabilité à assurer autrement (log vers stderr, ou `ctx.event`).

**Annulation :** le `Scope` de `execute` se ferme quand le stream est interrompu → on y branche
`session/cancel` (notification ACP) puis le kill du process. `TransportExecution.complete`
n'est pas utilisé par HTTP mais est disponible : bon point pour libérer la session.

---

## 9. Permissions

`session/request_permission` est un appel **serveur → client** pendant le stream, dans `execute`.
Le package provider n'a **pas** accès à `ctx.permission` (`Settings` = JSON plat).

Trois options, de la plus simple à la plus integrates :

1. **Auto-policy** (défaut) : `reject` pour `tools: "none"`, `allow-once` pour `tools: "all"`.
2. **Registre in-process** : le plugin exporte un bus (`permissions.request()`) ; le package
   provider l'importe via le **même chemin `file://` absolu** → identité de module garantie
   dans Bun. Permet d'afficher une vraie permission OpenCode.
3. ~~**Délégation fs/terminal**~~ — **abandonnée** : la RFD ACP v2 supprime cette surface
   client, et les agents ne l'utilisaient pas (§7.2).

Les permissions OpenCode sur les **outils OpenCode** sont nativement couvertes par le mécanisme
7.3 : ce sont de vrais `tool-call` de la boucle OpenCode, qui passent par le système de
permissions d'OpenCode sans code supplémentaire.

---

## 9bis. cwd — le point non résolu

`Transport.execute` ne reçoit **aucun contexte de session**, et `LLMRequest` n'a pas de champ
`cwd` (champs disponibles : `id?`, `model`, `system`, `messages`, `tools`, `toolChoice`,
`generation`, `providerOptions`, `http`, `cache`, `promptCacheKey`, `metadata`).

Options :

1. **`settings.cwd` statique**, renseigné par le plugin depuis `ctx.location.directory`.
   ⚠️ Le registre de providers est **global** alors que `ctx.location` est **par projet** : un
   serveur unique servant plusieurs projets partagerait le même cwd. À trancher (provider
   suffixé par projet, ou refus explicite en multi-projets).
2. **`request.metadata`** : champ « application-defined ». **À vérifier empiriquement en P0** —
   brancher un log de `JSON.stringify(request)` dans `body.from` pour voir ce que le core y
   place. Si le répertoire de session y figure, c'est la solution propre.
3. **`process.cwd()`** du serveur : correspond au répertoire de lancement d'OpenCode, pas
   nécessairement au répertoire de la session.

Tant que (2) n'est pas vérifié, on implémente (1) et on journalise.

---

## 9ter. Distribution

Le projet se publie comme **un seul package npm** exposant deux points d'entrée :

- le **plugin** (`plugins: ["opencode-acp-provider"]` dans `opencode.jsonc`)
- le **provider** (`package` du `Provider.Info`), chemin absolu `file://` calculé depuis
  `import.meta.url` → fonctionne aussi installé dans `node_modules`, pas seulement en local.

Prérequis : un build vers `dist/`, et le pinning de `@opencode/ai` + `effect` (cf. §1).
Le smoke test (P5) sert de garde-fou : il échoue bruyamment si le contrat des internals change
après une mise à jour d'OpenCode, plutôt que de laisser le provider casser silencieusement.

---

## 10. Sessions & continuité

`LLMRequest` ne contient **pas** de `sessionID` OpenCode — champs disponibles :
`id?`, `model`, `system`, `messages`, `tools`, `toolChoice`, `generation`, `providerOptions`,
`http`, `cache`, `promptCacheKey`, `metadata`.

Conséquence : impossible de mapper 1:1 une session OpenCode ↔ une session ACP par identifiant.
Deux stratégies :

- **`session: "fresh"`** (défaut, correct) : 1 `session/new` par requête, on rejoue l'historique
  OpenCode complet via `body.from`. Simple, sans état, mais lent (l'agent relit le dépôt).
- **`session: "reuse"`** : clé de cache = empreinte du **préfixe** de conversation + `cwd`
  (`sha256(cwd + ids des N premiers messages)`). Si la clé matche une session ACP vivante,
  on réutilise et on n'envoie que le delta. Heuristique : correct pour une conversation linéaire,
  à invalider sur `/compact`, fork ou changement de modèle.

---

## 11. Phases

| Phase | Livrable | Critère de fin |
| --- | --- | --- |
| **P0** | Scaffolding : `package.json`, `tsconfig.json`, versions pinnées, `acp/client.ts` + `acp/types.ts` | `initialize` + `session/new` marchent contre `copilot --acp` |
| **P0b** | **Spike cwd** : log de `JSON.stringify(request)` dans `body.from` | savoir si `request.metadata` porte le cwd de session (§9bis) |
| **P1** | `transport.ts` : spawn, JSON-RPC, `session/prompt`, stream de frames | les notifications ACP arrivent brutes dans `frames` |
| **P2** | `protocol.ts` : mapping `LLMEvent` (§4) + `errors.ts` | un `text-delta` s'affiche dans le TUI, `finish` propre, pas d'*ended unexpectedly* |
| **P2b** | **Mécanisme 7.3** : prompt (système + catalogue d'outils + transcript) et parsing de la sortie JSON | un `tool-call` émis **sans** `providerExecuted` déclenche un vrai outil OpenCode |
| **P3** | `plugin.ts` : enregistrement provider, découverte `configOptions` (§5), cleanup | `acp-copilot/<modèle>` visible dans `/model`, un chat fonctionne de bout en bout |
| **P4** | Policy permissions (§7.4), `session/cancel`, Errors §8 | aucune écriture par l'agent ; `Esc` interrompt proprement |
| **P5** | Tests : `smoke.test.ts` (contrat vs `@opencode/ai` pinné) + `fake-acp.ts` | le smoke échoue bruyamment si les internals changent |
| **P5b** | `probe/` : sondes ACP réutilisables (initialize, inventaire, set_config_option) | un agent ACP inconnu se qualifie en une commande |
| **P6** | Variants `thought_level`/`model_config` ; forward des serveurs MCP via `session/new` | `/model` effort switch ; MCP OpenCode visible depuis l'agent |
| **P7** | `adapters/openai-http` : serveur `/v1/chat/completions` (SSE) au-dessus du même cœur | `curl` un chat complet ; le plugin bascule sur `openai-compatible` si les internaux bougent |

P3 est le jalon de valeur. Si le mapping P2 se révèle trop strict, repli : revenir à l'Option A
en réutilisant `acp/` tel quel (le client ACP est identique).

---

## 12. Risques

| Risque | Impact | Mitigation |
| --- | --- | --- |
| Internals `@opencode/ai` non documentés | Cassure sur mise à jour mineure | pin exact + smoke test bruyant ; client ACP isolé |
| `effect@4.0.0-rc.112` (release candidate) | Instabilité des `Schema.Codec` | pin ; éviter les APIs `Schema` avancées, rester sur `Struct`/`String` |
| Séquence `LLMEvent` strictement validée | Crash silencieux | tests dédiés par type de notification ACP |
| Agent ACP qui ignore le refus d'outils | Écritures non souhaitées | `--available-tools` + policy + supervision ; `tools: "all"` pour la délégation |
| Sortie JSON malformée par l'agent | Boucle bloquée ou `tool-call` invalide | extraction tolérante (bloc ```json```, premier objet balanced), 1 tentative de réparation bornée, sinon `provider-error` explicite |
| L'agent dépense trop de tokens à formater du JSON | Qualité / coût | prompt compact, examples, ettemplage par agent si besoin |
| `providerExecuted` non géré par la boucle core | Double exécution | spike P2b : on émet **sans** `providerExecuted`, donc non concerné — sauf si on active un jour la délégation |
| `cwd` non disponible dans la requête | L'agent travaille dans le mauvais répertoire | spike P0b ; repli `settings.cwd` (§9bis) |
| Registre de providers global vs `ctx.location` par projet | cwd partagé entre projets | à trancher avant P3 |
| `codex` n'a pas de sous-commande `acp` en 0.154.0 | Nécessite l'adaptateur | `npx @agentclientprotocol/codex-acp` ; `copilot --acp` est natif |
| `usage` à mapper correctement | Coût/token absents de l'UI | **résolu** : `usage` ACP mesuré, cf. §4.1 |
| Ports/processus qui fuient | Fuite de sous-processus | `Scope` + finalizer ; P4 |

---

## 13. Questions ouvertes

1. **`copilot --acp` est-il stable ?** La doc indique *public preview* (janv. 2026). Le format
   `configOptions` peut encore bouger. À figer avec un adaptateur si possible.
2. **Le refus des permissions suffit-il à empêcher l'agent d'écrire ?** Certains agents
   traitent un refus comme fatal et abandonnent le tour. P0 doit tester ce comportement sur
   copilot **et** codex avant d'investir dans P2.
3. **L'agent accepte-t-il de produire du JSON de manière fiable ?** C'est **la** question la plus
   risquée du mécanisme 7.3, qui est désormais le cœur du design. P0b doit le mesurer sur copilot
   et codex : taux de sorties exploitables, Need de réparation, coût en tokens.
4. **`request.metadata` porte-t-il le cwd de session ?** Détermine si on peut se passer d'un
   `settings.cwd` statique (§9bis).
5. **Un provider ou plusieurs ?** Un seul `acp` avec plusieurs modèles est plus simple pour
   l'UX `/model`, mais credentials distinctes par agent (le token copilot n'est pas celui de
   codex) plaident pour un provider par agent (`acp-copilot`, `acp-codex`).
6. **Faut-il gérer le streaming de `rawInput` des tool calls ACP ?** Hors du chemin 7.3 (où la
   sortie est un bloc JSON), donc non bloquant.
