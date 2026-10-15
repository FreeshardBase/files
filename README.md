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

Thumbnails need `ffmpeg` (video frames) and `pdftoppm` from poppler-utils (PDF pages) on the `PATH`; images use `sharp`, which brings its own libvips. The container image installs both tools. `FILES_THUMB_CACHE_BYTES` caps the thumbnail cache (default 512 MiB) and `FILES_THUMB_TIMEOUT_MS` limits each generator run (default 30 000).

Name search answers from an index that the app keeps up to date on every change it makes. After files were changed on disk outside the app, or to recover a lost index, rebuild it with the same `FILES_*` environment as the server: `docker exec <container> node server/dist/reindex.js [userId…]` (all members without ids; it drops to uid 1000 itself), or `pnpm --filter @files/server reindex` in development. A change made while a home is being walked can be missed, so run it with the app idle or stopped.

## Container and the `/data` volume

The server keeps its database, user homes and the thumbnail cache in `/data`. On a shard, `/data` is a bind mount that the Docker daemon creates as root. The container therefore starts as root, but only long enough to do two things. First, it makes `/data` itself owned by `node` (uid 1000); it creates `/data` if it is missing. Second, it drops to uid 1000, and only then is anything opened. Existing contents are never chowned. If `/data` holds files from an earlier root-run container, chown them on the host once: `chown -R 1000:1000 <host dir>`. If `/data`, `files.db` or `homes/` is not writable after this step, the container exits 1 and names the path.

To check this with podman, use a root-owned, empty bind mount. Rootless podman maps your host user to root in the container, so a directory you own appears as root-owned inside:

```bash
podman build --format docker -t freeshard-files .
mkdir /tmp/files-data
podman run -d --name files-check --env-file .env -v /tmp/files-data:/data:Z freeshard-files
podman exec files-check stat -c '%u %n' /data /data/files.db   # 1000 /data, 1000 /data/files.db
podman top files-check user huser args                        # node runs as user node (uid 1000)
```
