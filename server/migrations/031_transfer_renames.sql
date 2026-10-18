-- A transfer item whose name the target's rules refuse (#342) lands under the suggested name; `renamed` keeps why, as the
-- JSON list of the name's issues, so the job and its report list every rename. NULL for an item that kept its name.
ALTER TABLE transfer_items ADD COLUMN renamed TEXT;
