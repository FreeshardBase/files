-- #337: logins without a name or email claim stored `sub` as the display name. Empty means "no name"; the web shows the
-- localized "Mitglied". The next login fills in whatever the claims carry then.
UPDATE users SET display_name = '' WHERE display_name = sub;
