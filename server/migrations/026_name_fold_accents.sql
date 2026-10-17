-- #235: the name index folds accents away as well as case ("umlaut" finds "Ümlaut"). Every stored fold is written again
-- from the row's own name by `files_name_fold`, the same function the server uses for new rows (db.ts, nameIndex.ts).
UPDATE name_index SET name_fold = files_name_fold(path);
