const EventEmitter = require('events');

const sseEmitter = new EventEmitter();
const clients = new Set();

/**
 * Handles incoming SSE connection on GET /api/events/stream
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function handleSSEConnection(req, res) {
  const userId = req.userId || (req.session && (req.session.userId || (req.session.user && req.session.user.id))) || 'anonymous';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const client = {
    id: Date.now() + '_' + Math.random().toString(36).substring(2, 9),
    userId,
    res,
    req
  };

  clients.add(client);

  // Send initial connection event
  const initPayload = {
    event: 'connected',
    user_id: userId,
    timestamp: new Date().toISOString()
  };
  res.write(`event: connected\ndata: ${JSON.stringify(initPayload)}\n\n`);

  req.on('close', () => {
    clients.delete(client);
  });
}

/**
 * Emit an SSE event to connected clients for a user
 * @param {string} userId - User ID or 'all'
 * @param {'file_uploaded'|'file_deleted'|'file_renamed'|'file_shared'} eventType - Event type name
 * @param {Object} data - Additional event details
 */
function emitSSEEvent(userId, eventType, data = {}) {
  const payload = {
    event: eventType,
    user_id: userId,
    data,
    timestamp: new Date().toISOString()
  };

  const message = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;

  for (const client of clients) {
    if (!userId || userId === 'all' || client.userId === userId || client.userId === 'anonymous') {
      try {
        client.res.write(message);
      } catch (err) {
        clients.delete(client);
      }
    }
  }

  sseEmitter.emit('sse_event', payload);
  return payload;
}

/**
 * Get count of active SSE client connections
 */
function getClientsCount() {
  return clients.size;
}

/**
 * Clean up all active clients (useful for testing)
 */
function removeAllClients() {
  for (const client of clients) {
    try {
      client.res.end();
    } catch (e) {}
  }
  clients.clear();
}

module.exports = {
  handleSSEConnection,
  emitSSEEvent,
  getClientsCount,
  removeAllClients,
  sseEmitter
};
