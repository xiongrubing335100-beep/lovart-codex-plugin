import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Presentation } from './presentation.js';

// Diagnostic-only store. Never reads Lovart credentials or calls a provider.
export class ProbeStore {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'probe.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS cards (
        probe_id TEXT PRIMARY KEY, nonce TEXT UNIQUE NOT NULL, prompt TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS clicks (
        request_id TEXT PRIMARY KEY, probe_id TEXT NOT NULL, correlation_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY, probe_id TEXT NOT NULL, event TEXT NOT NULL,
        observed_at TEXT NOT NULL);`);
    // Additive migration: old P0 processes keep reading the same card records.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare('PRAGMA table_info(cards)').all().some(c => c.name === 'presentation_json')) {
        this.db.exec('ALTER TABLE cards ADD COLUMN presentation_json TEXT');
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM cards WHERE probe_id=?').get(id);
    if (!row) throw new Error('PROBE_NOT_FOUND');
    return { contract_version: '1', ...row, mode: 'diagnostic_no_generation' };
  }
  create(nonce, prompt) {
    this.db.prepare('INSERT OR IGNORE INTO cards(probe_id,nonce,prompt) VALUES(?,?,?)')
      .run(randomUUID(), nonce, prompt);
    const row = this.db.prepare('SELECT * FROM cards WHERE nonce=?').get(nonce);
    if (row.prompt !== prompt) throw new Error('NONCE_CONFLICT');
    return this.get(row.probe_id);
  }
  importPresentation(nonce, input) {
    const data = Presentation.parse(input);
    const serialized = JSON.stringify(data);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT * FROM cards WHERE nonce=?').get(nonce);
      if (existing && existing.presentation_json !== serialized) throw new Error('NONCE_CONFLICT');
      if (!existing) this.db.prepare('INSERT INTO cards(probe_id,nonce,prompt,presentation_json) VALUES(?,?,?,?)')
        .run(randomUUID(), nonce, data.display_prompt ?? data.prompt ?? '原始提示词未返回', serialized);
      const record = this.db.prepare('SELECT probe_id FROM cards WHERE nonce=?').get(nonce);
      this.db.exec('COMMIT'); return this.get(record.probe_id);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  bump(id, requestId) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.get(id);
      let click = this.db.prepare('SELECT * FROM clicks WHERE request_id=?').get(requestId);
      if (click && click.probe_id !== id) throw new Error('REQUEST_CONFLICT');
      if (!click) {
        click = { correlation_id: randomUUID() };
        this.db.prepare('INSERT INTO clicks VALUES(?,?,?)').run(requestId, id, click.correlation_id);
        this.db.prepare('UPDATE cards SET count=count+1,revision=revision+1 WHERE probe_id=?').run(id);
      }
      const result = { ...this.get(id), correlation_id: click.correlation_id };
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  observe(id, event) {
    this.get(id);
    this.db.prepare('INSERT INTO observations(probe_id,event,observed_at) VALUES(?,?,?)')
      .run(id, event, new Date().toISOString());
    return this.get(id);
  }
  evidence(id) {
    return { ...this.get(id), observations: this.db.prepare(
      'SELECT event,observed_at FROM observations WHERE probe_id=? ORDER BY id').all(id) };
  }
  close() { this.db.close(); }
}
