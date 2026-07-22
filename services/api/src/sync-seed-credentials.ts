import { config } from "./config.js";
import { getDb, withTransaction } from "./db/client.js";
import { hashPassword } from "./lib/crypto.js";

if (!config.seedUsers) {
  throw new Error("SEED_USERS must be true to sync seed credentials");
}

const accounts: Array<{
  email: string;
  password: string;
  role: "admin" | "user";
}> = [
  {
    email: config.seedAdminEmail,
    password: config.seedAdminPassword,
    role: "admin",
  },
];

if (config.seedTestUser) {
  accounts.push({
    email: config.seedUserEmail,
    password: config.seedUserPassword,
    role: "user",
  });
}

const db = getDb();
for (const account of accounts) {
  const existing = db
    .prepare("SELECT role FROM users WHERE email = ?")
    .get(account.email) as { role: string } | undefined;
  if (!existing) throw new Error(`Seed account not found: ${account.email}`);
  if (existing.role !== account.role) {
    throw new Error(`Seed account role mismatch: ${account.email}`);
  }
}

withTransaction(() => {
  for (const account of accounts) {
    db.prepare("UPDATE users SET password_hash = ? WHERE email = ?").run(
      hashPassword(account.password),
      account.email,
    );
  }
});

console.log(
  JSON.stringify({
    ok: true,
    updated: accounts.map(({ email, role }) => ({ email, role })),
  }),
);
