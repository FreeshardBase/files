function requireAuth(req, res, next) {
  if (req.session && (req.session.userId || req.session.user)) {
    req.userId = req.session.userId || (req.session.user && req.session.user.id);
    return next();
  }
  res.status(401).json({ error: 'Authentication required' });
}

module.exports = {
  requireAuth
};
