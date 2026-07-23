function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  // Also check Remote-User header if injected by Authelia Forward Auth
  const remoteUser = req.headers['remote-user'];
  if (remoteUser) {
    req.session = req.session || {};
    req.session.userId = remoteUser;
    req.session.username = remoteUser;
    return next();
  }
  res.status(401).json({ error: 'Authentication required' });
}

module.exports = {
  requireAuth
};
