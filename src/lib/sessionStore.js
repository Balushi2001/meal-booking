// Minimal SQLite-backed store for express-session so logins survive restarts.
const session = require('express-session');
const { db } = require('../db');

class SqliteStore extends session.Store {
  get(sid, cb) {
    const row = db.prepare('SELECT data, expires FROM sessions WHERE sid = ?').get(sid);
    if (!row || row.expires < Date.now()) return cb(null, null);
    cb(null, JSON.parse(row.data));
  }
  set(sid, sess, cb) {
    const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
    db.prepare('INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires')
      .run(sid, JSON.stringify(sess), expires);
    cb && cb(null);
  }
  destroy(sid, cb) {
    db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
    cb && cb(null);
  }
  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }
  prune() {
    db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  }
}

module.exports = SqliteStore;
