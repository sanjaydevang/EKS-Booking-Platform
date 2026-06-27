const express = require('express');
const { pool } = require('../models/db');
const router = express.Router();
router.get('/live', (req, res) => res.json({ status: 'alive' }));
router.get('/ready', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ready' }); }
  catch (e) { res.status(503).json({ status: 'not ready', error: e.message }); }
});
module.exports = router;
