#!/usr/bin/env tsx
/**
 * Create Admin User
 * CLI script to create the first admin user for the RepGrid platform
 *
 * Usage: npx tsx scripts/create-admin.ts <email> <password> <name>
 */

import 'dotenv/config';
import { UserStore } from '../src/auth/users.js';

const [email, password, name] = process.argv.slice(2);

if (!email || !password || !name) {
  console.error('Usage: npx tsx scripts/create-admin.ts <email> <password> <name>');
  console.error('Example: npx tsx scripts/create-admin.ts admin@example.com secret123 "Admin User"');
  process.exit(1);
}

const store = new UserStore();

try {
  const user = await store.createUser(email, password, name, 'admin');
  console.log(`Admin user created successfully:`);
  console.log(`  ID:    ${user.id}`);
  console.log(`  Email: ${user.email}`);
  console.log(`  Name:  ${user.name}`);
  console.log(`  Role:  ${user.role}`);
} catch (error) {
  console.error('Failed to create user:', error instanceof Error ? error.message : error);
  process.exit(1);
} finally {
  store.close();
}
