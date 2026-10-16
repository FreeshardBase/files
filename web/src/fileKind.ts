// What a file is, in words, for the details drawer (#242 D1): the listed MIME type mapped to a kind ("PDF document",
// "Image (PNG)"), never the raw type. A type without a word of its own is a "File (.ext)".
import type { Entry } from '@files/shared';

export type FileKind = { key: string; params?: Record<string, string> };

const NAMED: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/zip': 'zip', 'application/x-zip-compressed': 'zip',
  'text/plain': 'text', 'text/markdown': 'markdown', 'text/csv': 'csv',
  'text/html': 'html', 'application/xhtml+xml': 'html',
  'application/json': 'json', 'application/xml': 'xml', 'text/xml': 'xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'word',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'spreadsheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'presentation',
};
// Images, video and audio name their format: the file's extension, or the MIME subtype without one.
const FAMILIES: Record<string, string> = { image: 'image', video: 'video', audio: 'audio' };

const extension = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : '';
};

export function fileKind(entry: Entry): FileKind {
  if (entry.type === 'directory') return { key: 'folder' };
  const mime = (entry.mime ?? '').split(';')[0]!.trim().toLowerCase();
  const named = NAMED[mime];
  if (named) return { key: named };
  const [family, sub = ''] = mime.split('/');
  const ext = extension(entry.name);
  const media = FAMILIES[family ?? ''];
  if (media && sub) return { key: media, params: { format: (ext || sub.split('+')[0]!).toUpperCase() } };
  return ext ? { key: 'other', params: { ext: ext.toLowerCase() } } : { key: 'file' };
}
