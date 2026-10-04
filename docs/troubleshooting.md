# Troubleshooting

## Plugin installed but no `acp/` model

`opencode models` exits before plugins finish loading, so it can show zero
`acp/` models with nothing being wrong. Verify against a persistent server
instead:

```bash
opencode serve --port 7881  # password printed at startup
curl -su opencode:<password> localhost:7881/api/plugin | grep acp-provider
curl -su opencode:<password> localhost:7881/api/model | grep acp/
```

## Plugin silently absent

A package that fails to load produces no error. `src/plugin.ts` writes one
line to stderr when the module is evaluated, outside `setup`'s `try`:

```
[opencode-acp-provider] module evaluated: file://…/src/plugin.ts
```

Line missing: the problem is upstream (path, installation, import error).
Line present: read `setup`'s log lines after it.

## Behaviour worth knowing

- **The `/connect` API key is decor.** Only the `key` method type carries a
  form, so OpenCode asks for a key it will never use — the plugin reads the
  form answers, never the key (locked by test). Type anything.

- **`auto` model filtered out.** It is a pseudo-value (the agent picks per
  turn without saying so); a `Model.Info` for it would lie about limits.
- **`default` effort level filtered out**, same reason: OpenCode rewrites that
  variant id into "no variant" and would never apply its settings.
- **Text inputs only.** The reducer cannot render images, so capabilities
  announce `input: ["text"]` rather than accepting images and losing them.
- **Declared limits, not measured.** ACP publishes no capabilities; defaults
  are `200000` / `32000`, tunable per agent via `limits`. An oversized context
  limit only delays compaction.
- **Refresh is triggered, not continuous.** Inventory re-reads happen at most
  once per `refreshMs` (default 60 s) after a finished turn (`session.idle`).
- **Discovery spawns its own process.** A second agent process per agent exists
  briefly at startup/refresh, distinct from the transport's. Sharing the
  transport cache at load time would pull the whole `effect` stack into the
  plugin process.
- **Namespaced tools are flattened** as `namespace_name` in the prompt; the
  emitted `tool-call` also carries the original `namespace` so OpenCode's
  registry finds the tool.
