'use strict';

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const streamManager = require('./streamManager');
const authRoutes = require('./routes/auth');
const streamRoutes = require('./routes/streams');

const app = express();
const PORT = 3000;
const NOVNC_PATH = '/usr/share/novnc';

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' },
}));

// Auth routes are public (login / logout)
app.use('/api', authRoutes);

// Auth guard — applied to everything registered after this point
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.path.startsWith('/api/') || req.path === '/api') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.redirect('/login.html');
}

// login.html is served without auth
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Everything below requires authentication
app.use(requireAuth);

// Used by nginx auth_request to validate the session before proxying VNC WebSockets.
// requireAuth above returns 401 for unauthenticated requests; this returns 200 for authenticated ones.
app.get('/api/auth-check', (req, res) => res.sendStatus(200));

// Serve noVNC static files (installed by the novnc apt package)
if (fs.existsSync(NOVNC_PATH)) {
  app.use('/novnc', express.static(NOVNC_PATH));
}

// Stream API
app.use('/api/streams', streamRoutes);

// Root → dashboard
app.get('/', (req, res) => res.redirect('/index.html'));

// Protected static files (index.html, vnc.html, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// Start server then auto-resume any streams that were running before shutdown
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`stream-headless listening on port ${PORT}`);

  const running = db.getRunning();
  if (running.length === 0) return;

  console.log(`Auto-resuming ${running.length} stream(s)…`);

  // Mark all as stopped first so display slots are treated as free
  for (const s of running) {
    db.setStatus(s.id, 'stopped', null);
  }

  for (const s of running) {
    try {
      await streamManager.startStream(s);
      console.log(`  Resumed: "${s.name}"`);
    } catch (err) {
      console.error(`  Failed to resume "${s.name}": ${err.message}`);
    }
  }
});
