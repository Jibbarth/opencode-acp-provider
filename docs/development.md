# Development

```bash
bun install
bun test            # full suite, incl. ACP chain against test/fake-acp.ts
bun run typecheck   # tsc --noEmit, strict + noUncheckedIndexedAccess
npm run verify:package
npm run verify:agent -- copilot --acp   # qualify an agent (see portability.md)
npm run verify:real copilot --acp      # live probe, needs an installed agent
npm run verify:resume copilot --acp    # measures session reuse vs fresh
```

## `verify:package`

Runs under **Node**, not Bun: `prepack` runs where publishing happens, in a CI
without Bun. It really imports both entry points and checks `default.setup`,
`model`, and that `Provider.Info.package` is an absolute `file://` URL to an
existing file — the same module as `exports["./provider"]`, so the host never
loads two instances (two `Usage` classes would fail `instanceof` with "The
provider response ended unexpectedly"). Node strips types but does not rewrite
`./x.js` specifiers, hence the `scripts/resolve-ts-extensions.mjs` hook. It is
wired into `prepack` and fails the publish on any contract break.

`src/core/publish.ts` imports nothing from `@opencode/plugin`, `effect` or
the SDK, which is what makes the inventory testable without a host (locked by
`test/publish.test.ts`).

## Versions

Exact pins for `@opencode/*` would freeze behind the CLI; a `~` range tracks
its patch line instead. Either way our copy must stay on the same
`major.minor`, at or above the floor: our provider builds `LanguageModel` and
`Usage` with our copy, the host reads them with its own — two copies break
`instanceof` ("The provider response ended unexpectedly").
`test/opencode.test.ts` locks the range, not a version. `effect` stays on
`rc.112` for the same reason: it must be the copy `@opencode/ai` was built
against (typecheck fails otherwise; even `@opencode/*@2.0.22` still depends on
the rc). Ranges (`^`) everywhere else; `bun.lock` keeps installs reproducible.

| Package | Version | Why |
| --- | --- | --- |
| `@opencode/ai`, `@opencode/schema` | `~2.0.16` | Same patch line as the shipping `opencode`; see above |
| `@opencode/plugin` | `~2.0.16` | Same patch line as the CLI that loads the plugin |
| `effect` | `4.0.0-rc.112` exact | Must match `@opencode/ai`'s copy; stable `4.0.0` breaks `tsc` until upstream moves |
| `@agentclientprotocol/sdk` | `^1.7.0` | The ACP protocol |
| `zod` | `^4.6.5` | Never imported directly; satisfies the ACP SDK's peer dependency |

`test/opencode.test.ts` fails if our `@opencode/ai` drifts from the one
`@opencode/plugin` declares.

## No build step

None needed. OpenCode runs on Bun and loads `.ts` sources directly, so the
published package ships `index.ts` + `src/`. `resolvePackageURL` also covers a
`dist/` layout if one is ever added. The debug CLI (`bun run src/adapters/cli.ts`,
aka `acp-run`) stays a dev tool and is not published.
