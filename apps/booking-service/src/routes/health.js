const express = require('express');
const { pool } = require('../models/db');

const router = express.Router();

// Kubernetes uses two probes:
// - /health/live  → liveness:  if this fails, K8s RESTARTS the pod
// - /health/ready → readiness: if this fails, K8s REMOVES pod from Service endpoints
//                               (stops sending traffic) but doesn't restart it

router.get('/live', (req, res) => {
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

router.get('/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ready', db: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'not ready', db: 'error', error: err.message });
  }
});

module.exports = router;
