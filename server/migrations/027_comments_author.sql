-- #308: a member has at most MAX_COMMENTS_PER_AUTHOR comments, live and trashed; the count is taken on every new comment.
CREATE INDEX comments_author ON comments(author_id);
