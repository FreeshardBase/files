-- SharePoint document libraries (#151): a connection may show one library the account can reach instead of the
-- account's own files. `drive` is that library's id ('' for the account's own files, and for a SharePoint connection
-- whose library is not picked yet); `drive_label` is "Site / Library" for the member. One account may be connected once
-- per library, so the uniqueness moves from the account to the account and its library.
ALTER TABLE connections ADD COLUMN drive TEXT NOT NULL DEFAULT '';
ALTER TABLE connections ADD COLUMN drive_label TEXT;
DROP INDEX connections_account;
CREATE UNIQUE INDEX connections_account ON connections(user_id, provider, account_id, drive);
