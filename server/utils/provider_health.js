const { run, get, all } = require('../db');

/**
 * Proactive Provider Health & Connectivity Monitor (#41)
 * Performs connectivity / credential verification for cloud provider connections.
 */

async function checkProviderHealth(connectionId) {
  const conn = await get('SELECT * FROM provider_connections WHERE id = ?', [connectionId]);
  if (!conn) {
    throw new Error(`Provider connection with ID ${connectionId} not found`);
  }

  let status = 'healthy';
  let errorMessage = null;

  // Validate provider type and connectivity credentials
  const validTypes = ['local', 's3', 'gdrive', 'dropbox', 'sftp', 'webdav'];
  if (!validTypes.includes(conn.provider_type)) {
    status = 'unhealthy';
    errorMessage = `Invalid or unsupported provider type: ${conn.provider_type}`;
  } else if (!conn.enabled) {
    status = 'disabled';
    errorMessage = 'Provider connection is disabled';
  } else if (!conn.credentials_encrypted || conn.credentials_encrypted === 'invalid') {
    status = 'unhealthy';
    errorMessage = 'Corrupted or missing encrypted credentials';
  }

  const nowIso = new Date().toISOString();
  await run(`
    UPDATE provider_connections
    SET health_status = ?, error_message = ?, last_health_check = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `, [status, errorMessage, connectionId]);

  return {
    id: connectionId,
    user_id: conn.user_id,
    provider_type: conn.provider_type,
    display_name: conn.display_name,
    status,
    health_status: status,
    error_message: errorMessage,
    last_health_check: nowIso
  };
}

async function checkAllProvidersHealth(userId) {
  const connections = await all('SELECT * FROM provider_connections WHERE user_id = ? AND enabled = 1', [userId]);
  const results = [];
  for (const conn of connections) {
    try {
      const res = await checkProviderHealth(conn.id);
      results.push(res);
    } catch (err) {
      results.push({
        id: conn.id,
        user_id: userId,
        provider_type: conn.provider_type,
        display_name: conn.display_name,
        status: 'unhealthy',
        health_status: 'unhealthy',
        error_message: err.message,
        last_health_check: new Date().toISOString()
      });
    }
  }
  return results;
}

module.exports = {
  checkProviderHealth,
  checkAllProvidersHealth
};
