// Where things live, for both the API and the SPA. A source is `home` today, later `conn:<id>` and `share:<id>`.

/** API base for one source: `/api/v1/sources/<source>`. */
export const sourceApi = (source: string): string => `/api/v1/sources/${encodeURIComponent(source)}`;

/** SPA location of a folder: `/<source>/<path…>`, each segment encoded. The source segment keeps folder
 * names such as `api` or `auth` from colliding with server routes on reload. */
export const folderRoute = (source: string, path: string): string =>
  `/${encodeURIComponent(source)}` + path.split('/').filter(Boolean).map((s) => '/' + encodeURIComponent(s)).join('');
