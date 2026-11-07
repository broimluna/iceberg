# tools

Test scripts for `web-api`. Each one starts a throwaway copy of the web
API with its own empty database (`lib/harness.ts`), so your real
`cpi_data.db` is never touched. Run them from the repo root with Bun.
Each prints `PASS`/`FAIL` lines and ends with `ALL PASSED` (exit 0) or
`N FAILURE(S)` (exit 1).

```sh
for t in tools/*-test.ts; do bun "$t" || break; done
```

| Script | What it checks |
|---|---|
| `mix-friends-test.ts` | Mix friend invites, accept, remove, trust and cancel. Every notification follows the client's strict "latest + 1" sequence rule. |
| `webapi-fixes-test.ts` | `X-HTTP-Method-Override` routing, the invitations table migration, and online/offline session handling. |
| `webapi-auth-test.ts` | CPI access-token auth with default settings: valid tokens work, while expired, unknown or raw-SWID tokens get 401 and never create accounts. |

`lib/harness.ts` exports `startWebApi()` (copy, start, `restart`,
`stop`, `logs`) and `makeChecker()` (`check` and `finish`).
