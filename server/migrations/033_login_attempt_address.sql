-- The address key (`addressKey`) a login attempt was started from (#419), so one address keeps at most
-- LOGIN_ATTEMPTS_PER_ADDRESS live attempts. Attempts started before have none and count only towards the global cap.
ALTER TABLE login_attempts ADD COLUMN address TEXT;
CREATE INDEX login_attempts_address ON login_attempts(address, expires_at);
