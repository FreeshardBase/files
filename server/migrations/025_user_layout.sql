-- #218, #219: a member's optional layouts (dual-pane view, browser-style tabs), off until they turn them on. A row first
-- written by a layout change gets the settings and sort defaults, the same as having no row.
ALTER TABLE user_settings ADD COLUMN dual_pane INTEGER NOT NULL DEFAULT 0 CHECK (dual_pane IN (0,1));
ALTER TABLE user_settings ADD COLUMN tabs INTEGER NOT NULL DEFAULT 0 CHECK (tabs IN (0,1));
