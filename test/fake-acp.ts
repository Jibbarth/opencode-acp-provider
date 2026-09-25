#!/usr/bin/env bun
/**
 * Agent ACP factice, construit avec le **vrai** SDK (`acp.agent()`) et parlant
 * sur stdio, exactement comme `copilot --acp`. Les tests le lancent comme un
 * sous-processus : on teste donc la chaîne complète spawn → ndJsonStream →
 * initialize → session/new → session/prompt, pas une version simplifiée in
 * process.
 *
 * Comportement observable (déterministe, sans latence) :
 *   - `initialize`  → protocole v1, `agentInfo: { name: "fake-acp", … }`
 *   - `session/new`  → 4 `configOptions` réalistes (3 modèles, 3 niveaux
 *                      d'effort, 2 modes dont un à URL longue, permissions)
 *   - `session/prompt` :
 *       · contient `PING`  → deux chunks texte `PO` puis `NG`
 *       · contient `NEED_PERMISSION` → demande une permission, puis annonce
 *         `DENIED` ou `ALLOWED` selon la réponse du client
 *       · sinon            → un chunk texte `ACK: <prompt>`
 *     puis `stop` avec un `usage`.
 */

import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk"

// ─────────────────────────────────────────────────────────────────────────────
// Données de l'inventaire
// ─────────────────────────────────────────────────────────────────────────────

const MODELS = [
  { value: "auto", name: "Auto", description: "Laisse l'agent choisir" },
  { value: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
  { value: "claude-sonnet-5", name: "Claude Sonnet 5" },
]

const THOUGHT_LEVELS = ["none", "medium", "high"]

/** Les identifiants de mode sont des URLs : c'est le cas réel qu'on veut couvrir. */
const MODES = [
  { value: "https://agentclientprotocol.com/registry/modes/agent#agent", name: "Agent" },
  { value: "https://agentclientprotocol.com/registry/modes/plan#plan", name: "Plan" },
]

const CONFIG_OPTIONS: acp.SessionConfigOption[] = [
  {
    id: "model",
    name: "Model",
    type: "select",
    category: "model",
    currentValue: "gpt-5.6-terra",
    options: MODELS,
  },
  {
    id: "reasoning_effort",
    name: "Reasoning effort",
    type: "select",
    category: "thought_level",
    currentValue: "medium",
    options: THOUGHT_LEVELS.map((value) => ({ value, name: value })),
  },
  {
    id: "mode",
    name: "Mode",
    type: "select",
    category: "mode",
    currentValue: MODES[0]?.value ?? "",
    options: MODES,
  },
  {
    id: "allow_all",
    name: "Allow all tools",
    type: "select",
    category: "permissions",
    currentValue: "off",
    options: [
      { value: "on", name: "On" },
      { value: "off", name: "Off" },
    ],
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Implémentation
// ─────────────────────────────────────────────────────────────────────────────

/** État par session : permet à `session/set_config_option` d'être réellementmutable. */
class FakeAgent {
  private readonly sessions = new Map<string, acp.SessionConfigOption[]>()

  initialize(): acp.InitializeResponse {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false, promptCapabilities: { image: false } },
      agentInfo: { name: "fake-acp", version: "0.1.0" },
    }
  }

  newSession(): acp.NewSessionResponse {
    const sessionId = `fake-${Math.random().toString(16).slice(2, 10)}`
    this.sessions.set(sessionId, structuredClone(CONFIG_OPTIONS))
    return { sessionId, configOptions: structuredClone(CONFIG_OPTIONS) }
  }

  setConfigOption(
    params: acp.SetSessionConfigOptionRequest,
  ): acp.SetSessionConfigOptionResponse {
    const current = this.sessions.get(params.sessionId) ?? structuredClone(CONFIG_OPTIONS)
    const next = current.map((option) => {
      if (option.id !== params.configId) return option
      if (option.type === "boolean") {
        return { ...option, currentValue: params.value === true }
      }
      return { ...option, currentValue: String(params.value) }
    })
    this.sessions.set(params.sessionId, next)
    // La spec impose de renvoyer l'état complet.
    return { configOptions: next }
  }

  async prompt(
    params: acp.PromptRequest,
    cx: acp.AgentContext,
  ): Promise<acp.PromptResponse> {
    const text = promptText(params)
    const notify = (update: acp.SessionUpdate): Promise<void> =>
      cx.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update })

    if (text.includes("NEED_PERMISSION")) {
      const response = await cx.request(acp.methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: "call-perm-1",
          title: "Écrire dans config.json",
          kind: "edit",
          status: "pending",
        },
        options: [
          { optionId: "allow-once", name: "Autoriser une fois", kind: "allow_once" },
          { optionId: "reject-once", name: "Refuser", kind: "reject_once" },
        ],
      })
      const outcome = response.outcome.outcome === "selected" ? response.outcome.optionId : "cancelled"
      const allowed = outcome === "allow-once"
      await notify({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: allowed ? "ALLOWED" : "DENIED" },
      })
    } else if (text.includes("PLAN")) {
      await notify({
        sessionUpdate: "plan",
        entries: [
          { content: "Analyser", priority: "high", status: "completed" },
          { content: "Implémenter", priority: "medium", status: "in_progress" },
        ],
      })
      await notify({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "PLAN_OK" },
      })
    } else if (text.includes("PING")) {
      await notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PO" } })
      await notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "NG" } })
    } else {
      await notify({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `ACK: ${text}` },
      })
    }

    return {
      stopReason: "end_turn",
      usage: { totalTokens: 42, inputTokens: 40, outputTokens: 2 },
    }
  }

  closeSession(params: acp.CloseSessionRequest): acp.CloseSessionResponse {
    this.sessions.delete(params.sessionId)
    return {}
  }
}

const promptText = (params: acp.PromptRequest): string =>
  params.prompt
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")

// ─────────────────────────────────────────────────────────────────────────────
// Câblage stdio
// ─────────────────────────────────────────────────────────────────────────────

const agent = new FakeAgent()

acp
  .agent({ name: "fake-acp" })
  .onRequest(acp.methods.agent.initialize, () => agent.initialize())
  .onRequest(acp.methods.agent.session.new, () => agent.newSession())
  .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => agent.setConfigOption(ctx.params))
  .onRequest(acp.methods.agent.session.prompt, (ctx) => agent.prompt(ctx.params, ctx.client))
  .onRequest(acp.methods.agent.session.close, (ctx) => agent.closeSession(ctx.params))
  .connect(
    acp.ndJsonStream(
      Writable.toWeb(process.stdout),
      Readable.toWeb(process.stdin),
    ),
  )
