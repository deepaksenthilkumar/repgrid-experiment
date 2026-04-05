/**
 * User Store
 * SQLite-based user management with bcrypt password hashing
 */

import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { join } from 'path';

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'researcher';
  createdAt: string;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: string;
  created_at: string;
}

const SALT_ROUNDS = 12;

export class UserStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath || join(process.cwd(), 'data', 'users.db');
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'researcher',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  async createUser(email: string, password: string, name: string, role: 'admin' | 'researcher' = 'researcher'): Promise<User> {
    const existing = this.db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      throw new Error(`User with email '${email}' already exists`);
    }

    const id = randomUUID();
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const createdAt = new Date().toISOString();

    this.db.prepare(
      'INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, email, passwordHash, name, role, createdAt);

    return { id, email, name, role, createdAt };
  }

  async verifyPassword(email: string, password: string): Promise<User | null> {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
    if (!row) return null;

    const valid = await bcrypt.compare(password, row.password_hash);
    if (!valid) return null;

    return {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role as 'admin' | 'researcher',
      createdAt: row.created_at,
    };
  }

  getUserById(id: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    if (!row) return null;

    return {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role as 'admin' | 'researcher',
      createdAt: row.created_at,
    };
  }

  listUsers(): User[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY created_at DESC').all() as UserRow[];
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role as 'admin' | 'researcher',
      createdAt: row.created_at,
    }));
  }

  getUserCount(): number {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    return result.count;
  }

  async seedFromEnv(): Promise<void> {
    const email = process.env.ADMIN_EMAIL;
    const password = process.env.ADMIN_PASSWORD;
    const name = process.env.ADMIN_NAME || 'Admin';

    if (!email || !password) {
      return;
    }

    const existing = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;

    if (!existing) {
      await this.createUser(email, password, name, 'admin');
      console.log(`[Auth] Seeded admin user: ${email}`);
      return;
    }

    // Check if password changed
    const passwordMatch = await bcrypt.compare(password, existing.password_hash);
    if (!passwordMatch) {
      const newHash = await bcrypt.hash(password, SALT_ROUNDS);
      this.db.prepare('UPDATE users SET password_hash = ?, name = ? WHERE email = ?').run(newHash, name, email);
      console.log(`[Auth] Updated password for admin user: ${email}`);
    } else {
      console.log(`[Auth] Admin user already up to date: ${email}`);
    }
  }

  close(): void {
    this.db.close();
  }
}
