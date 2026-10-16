// Where things live, for both the API and the SPA. A source is `home`, `share:<id>` (#146), later `conn:<id>`.

/** Where sign-out lands (#222): a page outside the signed-in shell that never redirects to the login. */
export const SIGNED_OUT_PATH = '/signed-out';

/** API base for one source: `/api/v1/sources/<source>`. */
export const sourceApi = (source: string): string => `/api/v1/sources/${encodeURIComponent(source)}`;

/** Download URL for items of one source: a single file as itself, a folder or several items as one streamed ZIP. */
export const downloadHref = (source: string, items: readonly { path: string; type: 'file' | 'directory' }[]): string =>
  items.length === 1 && items[0]!.type === 'file'
    ? `${sourceApi(source)}/content?path=${encodeURIComponent(items[0]!.path)}&download=1`
    : `${sourceApi(source)}/zip?${items.map((e) => `path=${encodeURIComponent(e.path)}`).join('&')}`;

/** SPA location of a folder: `/<source>/<path…>`, each segment encoded. The source segment keeps folder
 * names such as `api` or `auth` from colliding with server routes on reload. A source's own `:` stays readable
 * (`/share:<id>/…`); a source id has no other character that needs encoding. */
export const folderRoute = (source: string, path: string): string =>
  `/${encodeURIComponent(source).replace(/%3A/g, ':')}` + path.split('/').filter(Boolean).map((s) => '/' + encodeURIComponent(s)).join('');
