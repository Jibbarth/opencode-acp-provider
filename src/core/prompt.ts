/**
 * Construction du prompt ACP — PLAN.md §2.4 / §7.3.
 *
 * Ce module est la preuve exécutable de la promesse du §2.2 : il **n'importe
 * que du local**. Un adaptateur HTTP (`adapters/openai-http`) réutilisera
 * `renderRequest` sans tirer le SDK ACP — et donc `zod` et le typage généré —
 * dans son graphe de dépendances. C'est pour ça que la fonction vit ici et pas
 * dans `acp/agent.ts` : c'est de la construction de prompt, pas du protocole.
 *
 * ⚠️ Volontairement provisoire : la construction complète du prompt (système +
 * catalogue d'outils + contrat de sortie JSON, §7.3) arrive en P2b et remplacera
 * cette fonction. Pour l'instant on se contente de garder tout le texte visible,
 * ce qui suffit à valider la chaîne spawn → initialize → session/new → prompt →
 * events. Le marqueur est conservé tel quel pour que P2b sache qu'il y a
 * quelque chose à remplacer.
 */

import type { NormalizedMessage, NormalizedRequest } from "./types.js"

/**
 * Préfixe de rôle appliqué à chaque message du transcript.
 *
 * ⚠️ Ce préfixe n'est pas cosmétique : ACP n'a pas de champ « system » et le
 * transcript est rendu **à plat**. Sans lui, l'agent ne peut pas distinguer sa
 * propre sortie antérieure d'une instruction de l'utilisateur — or il doit
 * respecter un contrat de sortie JSON (§7.3) : confondre les deux est le pire
 * invariant à casser. On rend donc le rôle explicite, en français, comme le
 * reste du prompt.
 */
const rolePrefix = (message: NormalizedMessage): string => {
  switch (message.role) {
    case "user":
      return "Utilisateur"
    case "assistant":
      return "Assistant"
    case "tool":
      return `Outil ${message.name}`
  }
}

/** Rendu d'un message unique, rôle compris. */
const renderMessage = (message: NormalizedMessage): string =>
  `${rolePrefix(message)} : ${message.role === "tool" ? message.output : message.text}`

/**
 * Rendu texte minimal d'une `NormalizedRequest` : le système, puis le
 * transcript, chaque message précédé de son rôle.
 *
 * Le contrat de sortie JSON (§7.3) et le catalogue d'outils viendront ici en
 * P2b ; cette signature ne changera pas.
 */
export const renderRequest = (request: NormalizedRequest): string => {
  const parts: string[] = []
  if (request.system.length > 0) parts.push(request.system.join("\n\n"))
  for (const message of request.messages) parts.push(renderMessage(message))
  return parts.join("\n\n")
}
