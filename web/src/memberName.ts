import { i18n } from './i18n/index.ts';

/** How a member is shown: their display name, or the localized "Mitglied" when the login carried none (#337). */
export const memberName = (m: { displayName: string }): string => m.displayName || i18n.global.t('members.unnamed');
