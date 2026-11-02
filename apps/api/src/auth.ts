import argon2 from "argon2";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "./db.js";

export type Role = "ceo" | "admin" | "viewer";
export type Permission =
  | "read"
  | "tasks:write"
  | "agents:write"
  | "approvals:decide"
  | "memory:write"
  | "memory:admin"
  | "settings:write"
  | "secrets:write"
  | "users:admin";

/**
 * Role-based access control. Only the CEO can decide approvals, manage
 * secrets, change policies or administer users: final authority stays human.
 */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  ceo: ["read", "tasks:write", "agents:write", "approvals:decide", "memory:write", "memory:admin", "settings:write", "secrets:write", "users:admin"],
  admin: ["read", "tasks:write", "agents:write", "memory:write"],
  viewer: ["read"],
};

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; role: Role };
    user: { sub: string; role: Role };
  }
}

declare module "fastify" {
  interface FastifyRequest {
    session?: SessionUser;
  }
}

export const hashPassword = (p: string) => argon2.hash(p, { type: argon2.argon2id });
export const verifyPassword = (hash: string, p: string) => argon2.verify(hash, p).catch(() => false);

export async function loadUser(db: Db, id: string): Promise<SessionUser | null> {
  const r = (await db.query<SessionUser & { active: boolean }>(`SELECT id, email, name, role, active FROM users WHERE id=$1`, [id]))[0];
  return r && r.active ? { id: r.id, email: r.email, name: r.name, role: r.role } : null;
}

/** Route guard: valid session + permission. Role is re-read from the DB on every request. */
export function requirePermission(db: Db, perm: Permission) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "not authenticated" });
    }
    const user = await loadUser(db, req.user.sub);
    if (!user) return reply.code(401).send({ error: "account disabled or missing" });
    if (!ROLE_PERMISSIONS[user.role].includes(perm)) return reply.code(403).send({ error: `requires permission ${perm}` });
    req.session = user;
  };
}
