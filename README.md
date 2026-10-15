# Freeshard Files

FreeShard Files — a web-based file manager and multi-cloud hub, built as one of Freeshard's native shard apps.

**Work in progress, not ready for production use.** This project is under active
development and has open, unresolved security issues (tracked publicly in the
[issue tracker](https://github.com/FreeshardBase/files/issues), see the
[roadmap issue](https://github.com/FreeshardBase/files/issues/128) for current
status). It is not installed on any Freeshard shard today. Do not deploy this for
real file data yet.

## Development

```bash
export PATH=~/.local/node22/bin:$PATH
pnpm install
pnpm typecheck && pnpm lint && pnpm test   # unit + integration (Vitest)
pnpm e2e                                    # build + Playwright (desktop + mobile)
pnpm dev                                    # fake IdP on :4000 + server on :3005; run `pnpm --filter @files/web dev` for the SPA on :5173
```

Sign-in always goes through OIDC. `pnpm dev` starts a fake identity provider for you; there are no local accounts. See `CLAUDE.md` for the rules contributors and agents follow, `CONCEPTS.md` for the model and module map, and `DECISIONS.md` for decisions.
