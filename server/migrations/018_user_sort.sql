-- #226: a member's folder sort, in their settings row. A row first written by a sort change gets the settings defaults
-- (no language chosen, system theme), the same as having no row.
ALTER TABLE user_settings ADD COLUMN sort_key TEXT NOT NULL DEFAULT 'name' CHECK (sort_key IN ('name','size','modified'));
ALTER TABLE user_settings ADD COLUMN sort_dir TEXT NOT NULL DEFAULT 'asc' CHECK (sort_dir IN ('asc','desc'));
