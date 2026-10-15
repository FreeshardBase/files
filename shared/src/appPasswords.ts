import { z } from 'zod';

// App passwords (#157): the credential WebDAV clients use instead of the browser session.

/** How many app passwords one member may hold; one per device is the expected use. */
export const MAX_APP_PASSWORDS = 20;

/** Body of `POST /api/v1/app-passwords`: a label so the member recognises the device later. */
export const CreateAppPasswordRequest = z.strictObject({ label: z.string().trim().min(1).max(100) });
export type CreateAppPasswordRequest = z.infer<typeof CreateAppPasswordRequest>;

/** An app password as its member sees it in settings; the password itself is never listed. */
export const AppPasswordSchema = z.object({
  id: z.string(), label: z.string(), createdAt: z.iso.datetime(),
  /** The last time a client signed in with it; null until the first use. */
  lastUsedAt: z.iso.datetime().nullable(),
});
export type AppPassword = z.infer<typeof AppPasswordSchema>;

/** `GET /api/v1/app-passwords`: the caller's own, oldest first. */
export const AppPasswordListSchema = z.object({ items: z.array(AppPasswordSchema) });
export type AppPasswordList = z.infer<typeof AppPasswordListSchema>;

/** `POST /api/v1/app-passwords`: the only answer that ever carries the password. */
export const CreatedAppPasswordSchema = z.object({ item: AppPasswordSchema, password: z.string() });
export type CreatedAppPassword = z.infer<typeof CreatedAppPasswordSchema>;
