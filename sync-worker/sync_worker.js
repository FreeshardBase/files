const path = require('path');
const db = require('../server/db');

console.log('[SyncWorker] Starting FreeShard Files Sync Worker...');

async function loop() {
  while (true) {
    try {
      // Worker polling loop placeholder (see Issue #16)
    } catch (err) {
      console.error('[SyncWorker] Error in main loop:', err.message);
    }
    await new Promise(r => setTimeout(r, 10000));
  }
}

db.initDb().then(() => {
  console.log('[SyncWorker] Database initialized.');
  loop();
}).catch(err => {
  console.error('[SyncWorker] DB init error:', err);
});
