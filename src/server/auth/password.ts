import { hash, verify } from "@node-rs/argon2";

// OWASP-recommended argon2id parameters (19 MiB, t=2, p=1).
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

// A real hash of a random string, used to equalise timing when the email doesn't exist.
let dummyHash: Promise<string> | null = null;
export function dummyVerify(password: string) {
  dummyHash ??= hashPassword("timing-equaliser-" + Math.random());
  return dummyHash.then((h) => verifyPassword(h, password));
}

const COMMON = new Set([
  "password", "password1", "password123", "123456789", "1234567890", "qwertyuiop", "iloveyou",
  "welcome123", "admin12345", "letmein123", "monkey1234", "sunshine12", "football12", "abc1234567",
  "passw0rd123", "qwerty1234", "trustno1234", "baseball12", "dragon1234", "princess12",
]);

/** Returns a list of problems; empty means acceptable. */
export function passwordProblems(password: string, email?: string): string[] {
  const problems: string[] = [];
  if (password.length < 10) problems.push("Use at least 10 characters.");
  if (password.length > 128) problems.push("Use at most 128 characters.");
  if (/^(.)\1+$/.test(password)) problems.push("Don't repeat a single character.");
  if (COMMON.has(password.toLowerCase())) problems.push("This password is too common.");
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (password.length < 16 && classes < 2) problems.push("Mix letters with numbers or symbols (or use 16+ characters).");
  if (email) {
    const local = email.split("@")[0]?.toLowerCase();
    if (local && local.length >= 4 && password.toLowerCase().includes(local)) problems.push("Don't include your email in the password.");
  }
  return problems;
}
