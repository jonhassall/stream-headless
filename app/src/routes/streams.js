'use strict';

const router = require('express').Router();
const db = require('../db');
const streamManager = require('../streamManager');

// GET /api/streams — list all streams, enriched with runtime wsPort
router.get('/', (req, res) => {
  const streams = db.getAll().map(s => {
    const info = streamManager.getActiveInfo(s.id);
    return { ...s, wsPort: info ? info.wsPort : null };
  });
  res.json(streams);
});

// POST /api/streams — create a new stream
router.post('/', (req, res) => {
  const { name, url, rtmp_url, resolution, bitrate, audio_channels, show_address_bar } = req.body;

  if (!name || !url || !rtmp_url) {
    return res.status(400).json({ error: 'name, url, and rtmp_url are required' });
  }

  const result = db.create({
    name,
    url,
    rtmp_url,
    resolution:       resolution || '720p',
    bitrate:          parseInt(bitrate || 2500, 10),
    audio_channels:   parseInt(audio_channels || 2, 10),
    show_address_bar: show_address_bar ? 1 : 0,
  });

  res.status(201).json(db.getById(result.lastInsertRowid));
});

// PUT /api/streams/:id — update a stopped stream
router.put('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const stream = db.getById(id);
  if (!stream) return res.status(404).json({ error: 'Not found' });
  if (stream.status === 'running') {
    return res.status(409).json({ error: 'Stop the stream before editing' });
  }

  const { name, url, rtmp_url, resolution, bitrate, audio_channels, show_address_bar } = req.body;

  db.update(id, {
    name:             name             ?? stream.name,
    url:              url              ?? stream.url,
    rtmp_url:         rtmp_url         ?? stream.rtmp_url,
    resolution:       resolution       || stream.resolution,
    bitrate:          parseInt(bitrate ?? stream.bitrate, 10),
    audio_channels:   parseInt(audio_channels ?? stream.audio_channels, 10),
    show_address_bar: show_address_bar !== undefined
                        ? (show_address_bar ? 1 : 0)
                        : stream.show_address_bar,
  });

  res.json(db.getById(id));
});

// DELETE /api/streams/:id — stop (if running) then delete
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const stream = db.getById(id);
  if (!stream) return res.status(404).json({ error: 'Not found' });

  if (stream.status === 'running') {
    await streamManager.stopStream(id);
  }
  db.remove(id);
  res.json({ ok: true });
});

// POST /api/streams/:id/start
router.post('/:id/start', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const stream = db.getById(id);
  if (!stream) return res.status(404).json({ error: 'Not found' });
  if (stream.status === 'running') {
    return res.status(409).json({ error: 'Already running' });
  }

  try {
    const info = await streamManager.startStream(stream);
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/streams/:id/stop
router.post('/:id/stop', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const stream = db.getById(id);
  if (!stream) return res.status(404).json({ error: 'Not found' });
  if (stream.status !== 'running') {
    return res.status(409).json({ error: 'Not running' });
  }

  await streamManager.stopStream(id);
  res.json({ ok: true });
});

module.exports = router;
