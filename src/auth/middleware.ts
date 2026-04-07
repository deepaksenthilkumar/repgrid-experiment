/**
 * JWT Authentication Middleware
 * Fastify middleware + auth routes for user authentication
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { UserStore } from './users.js';
import type { User } from './users.js';

const JWT_EXPIRY = '7d';

/**
 * Simple in-memory rate limiter for authentication endpoints.
 * Tracks failed attempts by IP to prevent brute-force attacks.
 */
class AuthRateLimiter {
  private attempts = new Map<string, { count: number; resetAt: number }>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;

  constructor(maxAttempts = 5, windowMs = 60_000) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
  }

  isRateLimited(ip: string): boolean {
    const now = Date.now();
    const entry = this.attempts.get(ip);
    if (!entry || now > entry.resetAt) {
      return false;
    }
    return entry.count >= this.maxAttempts;
  }

  recordAttempt(ip: string): void {
    const now = Date.now();
    const entry = this.attempts.get(ip);
    if (!entry || now > entry.resetAt) {
      this.attempts.set(ip, { count: 1, resetAt: now + this.windowMs });
    } else {
      entry.count++;
    }
  }

  reset(ip: string): void {
    this.attempts.delete(ip);
  }
}

const authLimiter = new AuthRateLimiter();

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }
  if (secret.length < 32) {
    console.warn('[Auth] WARNING: JWT_SECRET is shorter than 32 characters. Use a longer secret in production.');
  }
  return secret;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}

/**
 * Register auth middleware and routes on a Fastify instance.
 * When AUTH_ENABLED=true (or JWT_SECRET is set), all routes except
 * /health and /auth/* require a valid Bearer token.
 */
export async function registerAuth(fastify: FastifyInstance, userStore: UserStore): Promise<void> {
  const authEnabled = !!process.env.JWT_SECRET;

  if (!authEnabled) {
    console.log('[Auth] JWT_SECRET not set — authentication disabled (dev mode)');
    return;
  }

  const secret = getJwtSecret();

  // Auth routes (public — no token required)
  fastify.post<{
    Body: { email: string; password: string };
  }>('/auth/login', async (request, reply) => {
    const clientIp = request.ip;

    // Rate limiting: block excessive login attempts
    if (authLimiter.isRateLimited(clientIp)) {
      reply.code(429);
      return { error: 'Too many login attempts. Please try again later.' };
    }

    const { email, password } = request.body || {};
    if (!email || !password) {
      reply.code(400);
      return { error: 'Email and password are required' };
    }

    const user = await userStore.verifyPassword(email, password);
    if (!user) {
      authLimiter.recordAttempt(clientIp);
      reply.code(401);
      return { error: 'Invalid email or password' };
    }

    // Reset rate limiter on successful login
    authLimiter.reset(clientIp);

    const token = jwt.sign({ sub: user.id, email: user.email, role: user.role }, secret, {
      expiresIn: JWT_EXPIRY,
    });

    return { token, user };
  });

  fastify.post<{
    Body: { email: string; password: string; name: string; role?: 'admin' | 'researcher' };
  }>('/auth/register', async (request, reply) => {
    // Only admins can register new users (or first user becomes admin)
    const isFirstUser = userStore.getUserCount() === 0;

    if (!isFirstUser) {
      // Verify caller is admin
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        reply.code(401);
        return { error: 'Authentication required' };
      }

      try {
        const payload = jwt.verify(authHeader.slice(7), secret) as { sub: string; role: string };
        if (payload.role !== 'admin') {
          reply.code(403);
          return { error: 'Only admins can register new users' };
        }
      } catch {
        reply.code(401);
        return { error: 'Invalid token' };
      }
    }

    const { email, password, name, role } = request.body || {};
    if (!email || !password || !name) {
      reply.code(400);
      return { error: 'Email, password, and name are required' };
    }

    try {
      const assignedRole = isFirstUser ? 'admin' : (role || 'researcher');
      const user = await userStore.createUser(email, password, name, assignedRole);

      const token = jwt.sign({ sub: user.id, email: user.email, role: user.role }, secret, {
        expiresIn: JWT_EXPIRY,
      });

      return { token, user, isFirstUser };
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : 'Failed to create user' };
    }
  });

  fastify.get('/auth/users', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.code(401);
      return { error: 'Authentication required' };
    }

    try {
      const payload = jwt.verify(authHeader.slice(7), secret) as { sub: string; role: string };
      if (payload.role !== 'admin') {
        reply.code(403);
        return { error: 'Only admins can list users' };
      }
      const users = userStore.listUsers();
      return { users };
    } catch {
      reply.code(401);
      return { error: 'Invalid token' };
    }
  });

  fastify.get('/auth/me', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.code(401);
      return { error: 'Authentication required' };
    }

    try {
      const payload = jwt.verify(authHeader.slice(7), secret) as { sub: string };
      const user = userStore.getUserById(payload.sub);
      if (!user) {
        reply.code(401);
        return { error: 'User not found' };
      }
      return { user };
    } catch {
      reply.code(401);
      return { error: 'Invalid token' };
    }
  });

  // Protected route middleware — skip auth routes and health check
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url.split('?')[0];

    // Public routes
    if (path === '/health' || path.startsWith('/auth/')) {
      return;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.code(401).send({ error: 'Authentication required' });
      return;
    }

    try {
      const payload = jwt.verify(authHeader.slice(7), secret) as { sub: string };
      const user = userStore.getUserById(payload.sub);
      if (!user) {
        reply.code(401).send({ error: 'User not found' });
        return;
      }
      request.user = user;
    } catch {
      reply.code(401).send({ error: 'Invalid or expired token' });
    }
  });

  console.log('[Auth] Authentication enabled');
}
