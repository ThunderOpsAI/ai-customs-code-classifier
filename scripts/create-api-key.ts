import 'dotenv/config';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import { computeFingerprint } from '../lib/auth';

interface CliArgs {
  account?: string;
  type?: 'prod' | 'test';
  credits?: number;
  email?: string;
  help?: boolean;
}

function printUsage(): void {
  console.log(`
Usage:
  npx tsx scripts/create-api-key.ts --account="Tenant Name" --type=prod --credits=100
  npx tsx scripts/create-api-key.ts --account="Tenant Name" --type=test

Options:
  --account, -a   Tenant or customer name (required)
  --type, -t      Key type: 'prod' or 'test' (required)
  --credits, -c   Number of initial credits to allocate or add (optional, default: 0)
  --email, -e     Optional email address for the account
  --help, -h      Display this help message

Environment Variables:
  DATABASE_URL    PostgreSQL connection string (e.g., from Neon, Supabase, or local)
`);
}

function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      result.help = true;
      return result;
    }

    if (arg.startsWith('--account=')) {
      result.account = arg.split('=', 2)[1];
    } else if (arg === '--account' || arg === '-a') {
      result.account = args[++i];
    } else if (arg.startsWith('--type=')) {
      const val = arg.split('=', 2)[1] as 'prod' | 'test';
      result.type = val;
    } else if (arg === '--type' || arg === '-t') {
      result.type = args[++i] as 'prod' | 'test';
    } else if (arg.startsWith('--credits=')) {
      const val = parseInt(arg.split('=', 2)[1], 10);
      if (!isNaN(val)) result.credits = val;
    } else if (arg === '--credits' || arg === '-c') {
      const val = parseInt(args[++i], 10);
      if (!isNaN(val)) result.credits = val;
    } else if (arg.startsWith('--email=')) {
      result.email = arg.split('=', 2)[1];
    } else if (arg === '--email' || arg === '-e') {
      result.email = args[++i];
    }
  }

  return result;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.help) {
    printUsage();
    process.exit(0);
  }

  if (!parsed.account) {
    console.error('Error: --account is required. (e.g. --account="Acme Logistics")');
    printUsage();
    process.exit(1);
  }

  if (!parsed.type || !['prod', 'test'].includes(parsed.type)) {
    console.error("Error: --type is required and must be either 'prod' or 'test'.");
    printUsage();
    process.exit(1);
  }

  const databaseUrl = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Error: DATABASE_URL environment variable is not defined.');
    console.error('Provide it via .env file or: DATABASE_URL="..." npx tsx scripts/create-api-key.ts ...');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // 1. Locate or create account
    const existingAccountRes = await client.query<{ id: string; name: string; email: string | null }>(
      'SELECT id, name, email FROM accounts WHERE name = $1 LIMIT 1',
      [parsed.account]
    );

    let accountId: string;
    let isNewAccount = false;

    if (existingAccountRes.rows.length > 0) {
      accountId = existingAccountRes.rows[0].id;
    } else {
      isNewAccount = true;
      const createAccountRes = await client.query<{ id: string }>(
        'INSERT INTO accounts (name, email) VALUES ($1, $2) RETURNING id',
        [parsed.account, parsed.email || null]
      );
      accountId = createAccountRes.rows[0].id;
    }

    // 2. Manage credits
    const creditDelta = parsed.credits && parsed.credits > 0 ? parsed.credits : 0;
    let balance = 0;

    if (isNewAccount) {
      const creditRes = await client.query<{ credits: number }>(
        'INSERT INTO credit_balances (account_id, credits) VALUES ($1, $2) RETURNING credits',
        [accountId, creditDelta]
      );
      balance = creditRes.rows[0].credits;
    } else {
      if (creditDelta > 0) {
        const creditRes = await client.query<{ credits: number }>(
          `INSERT INTO credit_balances (account_id, credits, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (account_id)
           DO UPDATE SET credits = credit_balances.credits + EXCLUDED.credits, updated_at = now()
           RETURNING credits`,
          [accountId, creditDelta]
        );
        balance = creditRes.rows[0].credits;
      } else {
        const creditRes = await client.query<{ credits: number }>(
          'SELECT credits FROM credit_balances WHERE account_id = $1',
          [accountId]
        );
        balance = creditRes.rows.length > 0 ? creditRes.rows[0].credits : 0;
      }
    }

    // 3. Generate raw key and hashes
    const randomEntropy = crypto.randomBytes(24).toString('hex');
    const rawKey = `${parsed.type}_${randomEntropy}`;
    const fingerprint = computeFingerprint(rawKey);
    const keyHash = await bcrypt.hash(rawKey, 10);

    // 4. Insert into api_keys table
    const keyRes = await client.query<{ id: string }>(
      `INSERT INTO api_keys (account_id, key_hash, prefix, key_fingerprint)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [accountId, keyHash, parsed.type, fingerprint]
    );
    const keyId = keyRes.rows[0].id;

    await client.query('COMMIT');

    // 5. Output key details
    console.log('\n============================================================');
    console.log('                 API KEY CREATED SUCCESSFULLY               ');
    console.log('============================================================\n');
    console.log(`Account Name:    ${parsed.account}`);
    console.log(`Account ID:      ${accountId} (${isNewAccount ? 'new account' : 'existing account'})`);
    console.log(`Key ID:          ${keyId}`);
    console.log(`Key Type:        ${parsed.type}`);
    console.log(`Fingerprint:     ${fingerprint}`);
    console.log(`Credit Balance:  ${balance} credits`);
    if (creditDelta > 0) {
      console.log(`Credits Added:   +${creditDelta}`);
    }
    console.log('\nPlaintext API Key (SAVE THIS NOW - it cannot be retrieved later):');
    console.log('------------------------------------------------------------');
    console.log(rawKey);
    console.log('------------------------------------------------------------\n');
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }
    console.error('\nFailed to create API key:', error);
    process.exit(1);
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

main();
