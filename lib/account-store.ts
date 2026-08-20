import fs from "node:fs";
import path from "node:path";
import { randomBytes, scryptSync } from "node:crypto";
import type { Role } from "@/types";
import { runtimeConfigFile, writeConfigJsonAtomic } from "@/lib/runtime-config";

export type AccountStatus = "pending" | "active" | "rejected" | "disabled";

export interface AccountRecord {
  id: string;
  username: string;
  name: string;
  email: string;
  role: Role;
  status: AccountStatus;
  salt: string;
  scrypt: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  approved_at?: string;
  approved_by?: string;
  rejected_at?: string;
  rejected_by?: string;
  reset_requested_at?: string;
  reset_contact_email?: string;
  session_version: number;
}

export interface AccountSettings {
  signup_enabled: boolean;
  updated_at: string;
  updated_by: string;
}

interface AccountStoreFile {
  version: 1;
  settings: AccountSettings;
  accounts: AccountRecord[];
}

export interface PublicAccount {
  id: string;
  username: string;
  name: string;
  email: string;
  role: Role;
  status: AccountStatus;
  created_at: string;
  created_by: string;
  updated_at: string;
  approved_at?: string;
  approved_by?: string;
  rejected_at?: string;
  rejected_by?: string;
  reset_requested_at?: string;
  reset_contact_email?: string;
}

const STORE_FILE = runtimeConfigFile("accounts.json");
const LEGACY_FILE = path.join(process.cwd(), "config", "users.json");
let cachedStore: { mtimeMs: number; value: AccountStoreFile } | null = null;

const now = () => new Date().toISOString();
const normalizeUsername = (value: string) => value.trim().toLowerCase();
const normalizeEmail = (value: string) => value.trim().toLowerCase();

function atomicWrite(value: AccountStoreFile): void {
  writeConfigJsonAtomic(STORE_FILE, value, 0o600);
  cachedStore = { mtimeMs: fs.statSync(STORE_FILE).mtimeMs, value };
}

function bootstrapStore(): AccountStoreFile {
  const created = now();
  let legacy: Array<{ username: string; name: string; role: string; salt: string; scrypt: string }> = [];
  try {
    legacy = JSON.parse(fs.readFileSync(LEGACY_FILE, "utf8")).users ?? [];
  } catch {
    // A fresh deployment can start without legacy users; the readiness route
    // will still expose that no usable admin account exists.
  }
  const accounts: AccountRecord[] = legacy
    .filter((user) => user.role === "admin" || user.role === "supervisor")
    .map((user) => ({
      id: `legacy-${normalizeUsername(user.username)}`,
      username: normalizeUsername(user.username),
      name: user.name.trim(),
      email: "",
      role: user.role as Role,
      status: "active",
      salt: user.salt,
      scrypt: user.scrypt,
      created_at: created,
      created_by: "legacy-bootstrap",
      updated_at: created,
      approved_at: created,
      approved_by: "legacy-bootstrap",
      session_version: 1,
    }));
  const store: AccountStoreFile = {
    version: 1,
    settings: { signup_enabled: false, updated_at: created, updated_by: "system" },
    accounts,
  };
  atomicWrite(store);
  return store;
}

function readStore(): AccountStoreFile {
  if (!fs.existsSync(STORE_FILE)) return bootstrapStore();
  const mtimeMs = fs.statSync(STORE_FILE).mtimeMs;
  if (cachedStore?.mtimeMs === mtimeMs) return cachedStore.value;
  const parsed = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) as AccountStoreFile;
  if (parsed.version !== 1 || !Array.isArray(parsed.accounts) || !parsed.settings) {
    throw new Error("Format penyimpanan akun tidak valid.");
  }
  cachedStore = { mtimeMs, value: parsed };
  return parsed;
}

let mutationQueue: Promise<unknown> = Promise.resolve();
function mutate<T>(operation: (store: AccountStoreFile) => T | Promise<T>): Promise<T> {
  const task = mutationQueue.then(async () => {
    const store = readStore();
    const result = await operation(store);
    atomicWrite(store);
    return result;
  });
  mutationQueue = task.then(() => undefined, () => undefined);
  return task;
}

function validateIdentity(input: { name: string; username: string; email: string }) {
  const name = input.name.trim().replace(/\s+/g, " ");
  const username = normalizeUsername(input.username);
  const email = normalizeEmail(input.email);
  if (name.length < 2 || name.length > 100) throw new Error("Nama lengkap harus 2–100 karakter.");
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    throw new Error("Username harus 3–32 karakter: huruf kecil, angka, titik, garis bawah, atau tanda hubung.");
  }
  if (!/^[^\s@]+@astronauts\.id$/i.test(email)) {
    throw new Error("Email wajib menggunakan domain @astronauts.id.");
  }
  return { name, username, email };
}

function validatePassword(password: string): string {
  if (password.length < 5) throw new Error("Password minimal 5 karakter.");
  if (password.length > 128) throw new Error("Password maksimal 128 karakter.");
  return password;
}

function passwordFields(password: string) {
  const salt = randomBytes(16).toString("hex");
  return { salt, scrypt: scryptSync(validatePassword(password), salt, 32).toString("hex") };
}

function publicAccount(account: AccountRecord): PublicAccount {
  const { salt: _salt, scrypt: _scrypt, session_version: _session, ...safe } = account;
  return safe;
}

export function getSignupSettings(): AccountSettings {
  return readStore().settings;
}

export function listAccounts(): PublicAccount[] {
  return readStore().accounts
    .map(publicAccount)
    .sort((a, b) => a.status.localeCompare(b.status) || b.created_at.localeCompare(a.created_at));
}

export function findAccountByUsername(username: string): AccountRecord | null {
  return readStore().accounts.find((item) => item.username === normalizeUsername(username)) ?? null;
}

export function findActiveAccount(username: string): AccountRecord | null {
  const account = findAccountByUsername(username);
  return account?.status === "active" ? account : null;
}

export async function setSignupEnabled(enabled: boolean, actor: string): Promise<AccountSettings> {
  return mutate((store) => {
    store.settings = { signup_enabled: enabled, updated_at: now(), updated_by: actor };
    return store.settings;
  });
}

export async function submitSignup(input: {
  name: string; username: string; email: string; password: string;
}): Promise<PublicAccount> {
  return mutate((store) => {
    if (!store.settings.signup_enabled) throw new Error("Pendaftaran sedang ditutup oleh admin.");
    const identity = validateIdentity(input);
    const sameUsername = store.accounts.find((item) => item.username === identity.username);
    const sameEmail = store.accounts.find((item) => item.email && item.email === identity.email);
    if (sameEmail && sameEmail.id !== sameUsername?.id) throw new Error("Email sudah digunakan.");
    if (sameUsername && sameUsername.status !== "rejected") throw new Error("Username sudah digunakan.");
    const stamp = now();
    if (sameUsername) {
      Object.assign(sameUsername, identity, passwordFields(input.password), {
        status: "pending" as const,
        role: "supervisor" as Role,
        updated_at: stamp,
        created_at: stamp,
        created_by: "self-signup",
        rejected_at: undefined,
        rejected_by: undefined,
        reset_requested_at: undefined,
        reset_contact_email: undefined,
        session_version: sameUsername.session_version + 1,
      });
      return publicAccount(sameUsername);
    }
    const account: AccountRecord = {
      id: `usr-${randomBytes(8).toString("hex")}`,
      ...identity,
      role: "supervisor",
      status: "pending",
      ...passwordFields(input.password),
      created_at: stamp,
      created_by: "self-signup",
      updated_at: stamp,
      session_version: 1,
    };
    store.accounts.push(account);
    return publicAccount(account);
  });
}

export async function createAccount(input: {
  name: string; username: string; email: string; password: string; role: Role;
}, actor: string): Promise<PublicAccount> {
  return mutate((store) => {
    const identity = validateIdentity(input);
    if (store.accounts.some((item) => item.username === identity.username)) throw new Error("Username sudah digunakan.");
    if (store.accounts.some((item) => item.email && item.email === identity.email)) throw new Error("Email sudah digunakan.");
    const stamp = now();
    const account: AccountRecord = {
      id: `usr-${randomBytes(8).toString("hex")}`,
      ...identity,
      role: input.role,
      status: "active",
      ...passwordFields(input.password),
      created_at: stamp,
      created_by: actor,
      updated_at: stamp,
      approved_at: stamp,
      approved_by: actor,
      session_version: 1,
    };
    store.accounts.push(account);
    return publicAccount(account);
  });
}

type AccountAction = "approve" | "reject" | "disable" | "activate" | "reset_password" | "set_role";

export async function updateAccount(input: {
  id: string; action: AccountAction; actor: string; actorUsername: string;
  password?: string; role?: Role;
}): Promise<PublicAccount> {
  return mutate((store) => {
    const account = store.accounts.find((item) => item.id === input.id);
    if (!account) throw new Error("Akun tidak ditemukan.");
    const activeAdmins = () => store.accounts.filter((item) => item.role === "admin" && item.status === "active").length;
    const removesActiveAdmin = account.role === "admin" && account.status === "active"
      && ["reject", "disable"].includes(input.action);
    if (removesActiveAdmin && activeAdmins() <= 1) throw new Error("Minimal satu akun admin harus tetap aktif.");
    if (account.username === input.actorUsername && input.action === "disable") {
      throw new Error("Admin tidak dapat menonaktifkan akunnya sendiri.");
    }
    const stamp = now();
    if (input.action === "approve") {
      if (account.status !== "pending") throw new Error("Hanya pendaftaran pending yang dapat disetujui.");
      account.status = "active";
      account.role = "supervisor";
      account.approved_at = stamp;
      account.approved_by = input.actor;
    } else if (input.action === "reject") {
      if (account.status !== "pending") throw new Error("Hanya pendaftaran pending yang dapat ditolak.");
      account.status = "rejected";
      account.rejected_at = stamp;
      account.rejected_by = input.actor;
    } else if (input.action === "disable") {
      account.status = "disabled";
    } else if (input.action === "activate") {
      account.status = "active";
      account.approved_at ??= stamp;
      account.approved_by ??= input.actor;
    } else if (input.action === "reset_password") {
      if (!input.password) throw new Error("Password baru wajib diisi.");
      Object.assign(account, passwordFields(input.password));
      account.reset_requested_at = undefined;
      account.reset_contact_email = undefined;
    } else if (input.action === "set_role") {
      if (!input.role) throw new Error("Role wajib dipilih.");
      if (account.role === "admin" && input.role !== "admin" && account.status === "active" && activeAdmins() <= 1) {
        throw new Error("Minimal satu akun admin harus tetap aktif.");
      }
      account.role = input.role;
    }
    account.updated_at = stamp;
    account.session_version += 1;
    return publicAccount(account);
  });
}

export async function requestPasswordReset(username: string, email: string): Promise<void> {
  return mutate((store) => {
    const normalizedUsername = normalizeUsername(username);
    const normalizedEmail = normalizeEmail(email);
    const workEmail = /^[^\s@]+@astronauts\.id$/i.test(normalizedEmail);
    const account = store.accounts.find((item) =>
      item.status === "active"
      && item.username === normalizedUsername
      && workEmail
      && (!item.email || item.email === normalizedEmail));
    if (account) {
      account.reset_requested_at = now();
      account.reset_contact_email = normalizedEmail;
      account.updated_at = account.reset_requested_at;
    }
  });
}

export function accountStoreStatus(): { ready: boolean; activeAdmins: number; error?: string } {
  try {
    const store = readStore();
    return {
      ready: store.accounts.some((item) => item.role === "admin" && item.status === "active"),
      activeAdmins: store.accounts.filter((item) => item.role === "admin" && item.status === "active").length,
    };
  } catch (error) {
    return { ready: false, activeAdmins: 0, error: (error as Error).message };
  }
}
