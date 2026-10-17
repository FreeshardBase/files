# Performance and packaging (#300)

## Container smoke test

`pnpm smoke:container` runs `scripts/container-smoke.sh`. Without podman it prints `container smoke SKIPPED: …` and exits 0. Otherwise it:

1. builds the image from the `Dockerfile` with `podman build --format docker`;
2. starts it with no configuration and expects it to exit non-zero with a message naming `FILES_SESSION_SECRET`;
3. starts the fake IdP (`scripts/smoke/fake-idp.ts`) on the host, then the image on a fresh podman volume as `/data`, with random secrets and host networking (the server must reach the IdP on loopback, and http is allowed only for loopback URLs);
4. waits for `/healthz` to answer `{"status":"ok"}` and runs the image's own `HEALTHCHECK`;
5. checks that the server process (PID 1) runs as uid and gid 1000;
6. signs in as `testuser` through the fake IdP, uploads 1 MiB of random bytes with `PUT …/content` and downloads them again byte for byte;
7. stops the container and expects exit code 0 (a clean shutdown).

Container and volume are removed in every case. Rootless podman maps the host user to root in the container, so nothing runs as root on the host. The image starts as root only to hand `/data` to uid 1000 (README, "Container and the `/data` volume").

Result on 2026-10-17: passed (podman, rootless).

## Load test, local backend

`pnpm load` runs `scripts/load/run.ts`. It boots the real app (`NODE_ENV=production`, fake IdP sign-in) on a loopback port, with a temp data dir under `$TMPDIR`. Peak disk use is about 3 GB, because the 5 GB file and the 1 GB folder (16 × 64 MB) are sparse. The script seeds one home with:

- 10 000 small text files in 200 folders: 2 040 in the biggest, 40 in each of the others;
- one 5 GB file;
- the 1 GB folder;
- 500 JPEGs of 1024 × 768 with noise, so they do not compress to nothing.

Every step goes over HTTP like the SPA, except the index rebuild, which is the `reindex` command's function. Uploads use tus in the SPA's 8 MB chunks. Thumbnail requests run 6 at a time, as a browser opening a grid does.

Client and server share one process, so peak RSS and the longest event-loop stall (`monitorEventLoopDelay`, 10 ms resolution) include the client's small share of the work: it discards what it reads, and the upload client keeps one 8 MB chunk.

Machine: 16 cores, 62 GB RAM, local SSD (ext4 on LVM), Node 22.23. Run on 2026-10-17:

| Step | Time | Longest event-loop stall | Peak RSS | Result |
| --- | ---: | ---: | ---: | --- |
| rebuild of the name index | 237 ms | 10 ms | 177 MB | 10 721 items indexed |
| storage overview | 175 ms | 15 ms | 180 MB | largest folders from the index |
| copy of the 10 000-file folder | 88 531 ms | 43 ms | 182 MB | 10 000 files copied |
| rename of the copied folder | 53 ms | 0 ms | 182 MB | index rows follow |
| delete of the copied folder to the trash | 211 ms | 30 ms | 183 MB | one trash item |
| empty the trash | 117 ms | 33 ms | 194 MB | 10 000 files freed |
| list the biggest folder (all pages of 200) | 83 ms | 12 ms | 195 MB | 2 040 entries in 11 pages |
| search "file" (matches all 10 000) | 4 ms | 0 ms | 195 MB | 50 results |
| search "file-09999" | 2 ms | 0 ms | 196 MB | 1 result |
| search "nothing-matches" | 2 ms | 0 ms | 196 MB | 0 results |
| ZIP of the 1 GB folder | 1 829 ms | 11 ms | 231 MB | 1 024 MB streamed |
| download of the 5 GB file | 5 463 ms | 11 ms | 230 MB | 5 120 MB streamed |
| 8 parallel tus uploads of 200 MB | 4 652 ms | 53 ms | 442 MB | 1 600 MB stored |
| thumbnails for 500 images | 3 865 ms | 37 ms | 330 MB | 500 generated |

## Findings

- **No O(n²), no whole-file buffering, no stall over 200 ms.** The longest stall in any step was 53 ms. The ZIP stays at 231 MB RSS, under the 300 MB the issue sets. The 5 GB download does not grow RSS. The 8 uploads add about 250 MB to client and server together for 1.6 GB stored. That is allocator headroom for 8 MB chunks in flight, not the uploads held in memory.
- **Search** is a scan over the member's index rows (`instr` in SQLite) and takes milliseconds at 10 000 items.
- **Listing** reads and sorts the whole folder for each page, so walking all pages of a folder costs pages × n log n. At 2 040 entries that is 83 ms for all 11 pages. It would only matter for folders of 100 000 entries and more, so it is left alone (YAGNI).
- **Copy** is linear but slow: about 9 ms per small file. Every copied file and folder is fsynced before the copy counts as done (`copyTree`), on purpose (durability, spec §3). The SPA runs copies as transfer jobs, so no request waits for one. The event loop stays free (43 ms) while it runs.
- **A fetch client that cancels a body** (`body.cancel()`) keeps undici's socket open. The server then holds that response until the client goes away, and a graceful close waits for it, bounded by `main.ts`'s 10 s shutdown limit. A client that closes the socket frees the request at once. This is TCP behaviour, not a server leak. The tests read every body to the end.

Nothing needed fixing. `server/test/load.test.ts` pins the profile at suite scale, over a real socket:

- listing a 2 040-entry folder page by page;
- search and index rebuild over 10 000 files;
- a 1 GB ZIP with RSS growth under 200 MB (buffering it adds about 1 GB and fails the test);
- 8 parallel 64 MB tus uploads, compared byte for byte, with RSS growth under 400 MB;
- 100 thumbnails.

Every one of these must stay under 200 ms of event-loop stall.
