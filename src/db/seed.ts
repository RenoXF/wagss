import { hashPassword } from '@/auth/password';
import { sql } from './client';
import { migrate } from './migrate';

interface SeedArgs {
  username: string;
  password: string;
  displayName: string;
  protected: boolean;
}

function parseArgs(argv: string[]): SeedArgs {
  const args: SeedArgs = {
    username: '',
    password: '',
    displayName: '',
    protected: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const val = argv[i + 1];
    if (arg === '--username' && val) args.username = val;
    if (arg === '--password' && val) args.password = val;
    if (arg === '--displayName' && val) args.displayName = val;
    if (arg === '--no-protected') args.protected = false;
  }
  if (!args.username || !args.password) {
    console.error(
      'Usage: bun run db:seed --username <name> --password <pass> [--displayName <name>] [--no-protected]',
    );
    process.exit(1);
  }
  if (!args.displayName) args.displayName = args.username;
  return args;
}

if (import.meta.main) {
  await migrate();
  const args = parseArgs(process.argv.slice(2));

  const exists =
    await sql`SELECT id FROM users WHERE username = ${args.username}`;
  if (exists.length > 0) {
    console.error(`[DB] User '${args.username}' already exists`);
    process.exit(1);
  }

  const passwordHash = await hashPassword(args.password);
  await sql`
    INSERT INTO users (username, password_hash, display_name, protected)
    VALUES (${args.username}, ${passwordHash}, ${args.displayName}, ${args.protected})
  `;
  console.log(
    `[DB] Seeded user '${args.username}' (${args.displayName})${args.protected ? ' [protected]' : ''}`,
  );
  await sql.end();
}
