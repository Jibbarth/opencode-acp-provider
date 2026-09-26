/**
 * The pure mapping from the provider setting `allowedTools` to the spawn
 * arguments reducing the agent's **native** tool surface.
 *
 * These tests spawn **no** subprocess: the mapping is a pure function of the
 * setting (`settings.ts`), and its whole domain is the four shapes the setting
 * can take. What `createAcpAgent` then does with the result — append it to the
 * spawn arguments, or nothing at all by default — is covered by the
 * "surface reduction at spawn" tests in `acp.test.ts`, against the real
 * subprocess.
 */

import { describe, expect, test } from "bun:test"

import { availableToolsArgs } from "../src/settings.js"

describe("availableToolsArgs", () => {
  test("deny-all (`[]`) reduces the surface to nothing", () => {
    // The empty list is the degenerate case of the flag's documented
    // comma-separated syntax: no tool name, hence no tool.
    expect(availableToolsArgs([])).toEqual(["--available-tools", ""])
  })

  test("allow-all (`[\"*\"]`) leaves the surface alone", () => {
    // A flag restricting to "*" would be a restriction the setting does not
    // ask for: "all" is the absence of a flag, not a value of one.
    expect(availableToolsArgs(["*"])).toEqual([])
  })

  test("an explicit list restricts the surface to exactly those tools", () => {
    // Comma-separated, per the flag's documented syntax ("For multiple
    // tools, use a quoted, comma-separated list").
    expect(availableToolsArgs(["read_file", "write_file"])).toEqual([
      "--available-tools",
      "read_file,write_file",
    ])
  })

  test("an agent that does not accept the flag gets no argument at all", () => {
    // `undefined` is the absence of opt-in: the caller did not declare that
    // this agent accepts `--available-tools`. An unknown flag would kill the
    // spawn - a worse failure than no restriction - so none is invented, and
    // the permission policy (which refuses everything by default) remains the
    // only layer.
    expect(availableToolsArgs(undefined)).toEqual([])
  })

  test("a list mixing \"*\" with other names is allow-all, exactly like the policy", () => {
    // `allowsEveryTool` decides the permission policy the same way: "*" is
    // not a tool name among others, it is the absence of a restriction. The
    // two layers must not disagree on what "all" means.
    expect(availableToolsArgs(["*", "read_file"])).toEqual([])
  })
})
