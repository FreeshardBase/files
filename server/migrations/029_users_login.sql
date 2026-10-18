-- #321: the login name from the IdP (`preferred_username`, else the email), shown on the phone setup page as the user
-- name for WebDAV. Empty until the member's next login.
ALTER TABLE users ADD COLUMN login TEXT;
