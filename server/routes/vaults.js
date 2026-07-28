const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// Apply authentication middleware across all vault endpoints
router.use(requireAuth);

// ── GET /api/vaults ──────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const vaults = await db.getVaultsByUser(req.userId);
    res.json({ success: true, vaults });
  } catch (err) {
    console.error('[Vaults] Error listing vaults:', err);
    res.status(500).json({ error: 'Failed to list vaults' });
  }
});

// ── POST /api/vaults/create ──────────────────────────────────────────────────
router.post('/create', async (req, res) => {
  try {
    const { name, salt, encrypted_metadata, encryptedMetadata } = req.body;
    const metadata = encrypted_metadata || encryptedMetadata;

    if (!name || !salt || !metadata) {
      return res.status(400).json({ error: 'Name, salt, and encrypted_metadata are required' });
    }

    const vault = await db.createVault(req.userId, name, salt, metadata);
    res.status(201).json({ success: true, vault });
  } catch (err) {
    console.error('[Vaults] Error creating vault:', err);
    res.status(500).json({ error: 'Failed to create vault' });
  }
});

// ── POST /api/vaults/unlock ──────────────────────────────────────────────────
router.post('/unlock', async (req, res) => {
  try {
    const vaultId = req.body.vault_id || req.body.vaultId || req.body.id;

    if (!vaultId) {
      return res.status(400).json({ error: 'vault_id is required' });
    }

    const vault = await db.getVaultById(vaultId, req.userId);
    if (!vault) {
      return res.status(404).json({ error: 'Vault not found' });
    }

    res.json({ success: true, vault });
  } catch (err) {
    console.error('[Vaults] Error unlocking vault:', err);
    res.status(500).json({ error: 'Failed to unlock vault' });
  }
});

module.exports = router;
