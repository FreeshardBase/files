const db = require('../db');

async function requireAuth(req, res, next) {
  if (req.userId) {
    return next();
  }
  if (req.session && (req.session.userId || req.session.user)) {
    req.userId = req.session.userId || (req.session.user && req.session.user.id);
    return next();
  }

  const authHeader = req.headers.authorization;
  const patHeader = req.headers['x-pat-token'];
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (patHeader) {
    token = patHeader.trim();
  }

  if (token) {
    try {
      const pat = await db.getPersonalAccessTokenByToken(token);
      if (pat) {
        req.userId = pat.user_id;
        return next();
      }
    } catch (err) {
      console.warn('[PAT Auth Error]', err.message);
    }
  }

  res.status(401).json({ error: 'Authentication required' });
}

function requireRole(...allowedRoles) {
  return async function (req, res, next) {
    if (!req.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    try {
      const role = await db.getUserRole(req.userId);
      req.userRole = role;
      if (allowedRoles.length > 0 && !allowedRoles.includes(role)) {
        return res.status(403).json({ error: `Forbidden: Role '${role}' does not have permission` });
      }
      next();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}

const requireAdmin = requireRole('admin');

async function enforceFileAccessRole(req, res, next) {
  if (!req.userId) return next();
  try {
    const role = req.userRole || await db.getUserRole(req.userId);
    req.userRole = role;
    const mutatingMethods = ['POST', 'PUT', 'DELETE', 'PATCH'];
    if (role === 'viewer' && mutatingMethods.includes(req.method)) {
      await db.logFileAccess(req.userId, role, req.method.toLowerCase(), req.path || '/', 'denied', 'Viewer role cannot modify files');
      return res.status(403).json({ error: "Forbidden: 'viewer' role cannot perform write operations" });
    }
    next();
  } catch (err) {
    next();
  }
}

module.exports = {
  requireAuth,
  requireRole,
  requireAdmin,
  enforceFileAccessRole
};


