'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || '/data/db.sqlite';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS streams (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    url              TEXT    NOT NULL,
    rtmp_url         TEXT    NOT NULL,
    resolution       TEXT    NOT NULL DEFAULT '720p',
    bitrate          INTEGER NOT NULL DEFAULT 2500,
    audio_channels   INTEGER NOT NULL DEFAULT 2,
    show_address_bar INTEGER NOT NULL DEFAULT 0,
    status           TEXT    NOT NULL DEFAULT 'stopped',
    display_num      INTEGER,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
  )
`);

const getAll = () =>
  db.prepare('SELECT * FROM streams ORDER BY id').all();

const getById = (id) =>
  db.prepare('SELECT * FROM streams WHERE id = ?').get(id);

const getRunning = () =>
  db.prepare("SELECT * FROM streams WHERE status = 'running'").all();

const create = ({ name, url, rtmp_url, resolution, bitrate, audio_channels, show_address_bar }) =>
  db.prepare(`
    INSERT INTO streams (name, url, rtmp_url, resolution, bitrate, audio_channels, show_address_bar)
    VALUES (@name, @url, @rtmp_url, @resolution, @bitrate, @audio_channels, @show_address_bar)
  `).run({ name, url, rtmp_url, resolution, bitrate, audio_channels, show_address_bar });

const update = (id, { name, url, rtmp_url, resolution, bitrate, audio_channels, show_address_bar }) =>
  db.prepare(`
    UPDATE streams
    SET name = @name, url = @url, rtmp_url = @rtmp_url,
        resolution = @resolution, bitrate = @bitrate,
        audio_channels = @audio_channels, show_address_bar = @show_address_bar
    WHERE id = @id
  `).run({ id, name, url, rtmp_url, resolution, bitrate, audio_channels, show_address_bar });

const setStatus = (id, status, display_num = null) =>
  db.prepare('UPDATE streams SET status = ?, display_num = ? WHERE id = ?')
    .run(status, display_num, id);

const remove = (id) =>
  db.prepare('DELETE FROM streams WHERE id = ?').run(id);

module.exports = { getAll, getById, getRunning, create, update, setStatus, remove };
