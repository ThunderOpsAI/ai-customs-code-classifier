import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Types
interface UsitcRawItem {
  htsno?: string;
  indent?: string;
  description?: string;
  superior?: string | null;
  [key: string]: unknown;
}

interface ParsedHsEntry {
  hs_code: string;
  official_description: string;
}

interface CliOptions {
  limit?: number;
  mock: boolean;
  dryRun: boolean;
  fast: boolean;
  url?: string;
  file?: string;
  noCache: boolean;
}

const PRIMARY_USITC_URL = 'https://hts.usitc.gov/reststop/exportHts?release=2024&format=json';
const FALLBACK_USITC_URL = 'https://hts.usitc.gov/reststop/exportList?from=0101&to=9999&format=JSON&styles=false';
const CACHE_FILE_PATH = path.join(process.cwd(), '.cache', 'usitc_hts_export.json');

// Parse CLI flags
function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    mock: false,
    dryRun: false,
    fast: false,
    noCache: false,
  };

  for (const arg of args) {
    if (arg.startsWith('--limit=')) {
      const val = parseInt(arg.split('=')[1], 10);
      if (!isNaN(val) && val > 0) {
        options.limit = val;
      }
    } else if (arg === '--mock') {
      options.mock = true;
    } else if (arg === '--fast' || arg === '--skip-llm-expansion') {
      options.fast = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--no-cache') {
      options.noCache = true;
    } else if (arg.startsWith('--url=')) {
      options.url = arg.split('=')[1];
    } else if (arg.startsWith('--file=')) {
      options.file = arg.split('=')[1];
    }
  }

  return options;
}

// Clean HTML tags and entities
export function cleanHtml(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Fetch USITC dataset with fallback
async function fetchUsitcDataset(options: CliOptions): Promise<UsitcRawItem[]> {
  // 1. If explicit file passed
  if (options.file) {
    console.log(`[INFO] Reading USITC data from specified file: ${options.file}`);
    const raw = fs.readFileSync(options.file, 'utf-8');
    return JSON.parse(raw);
  }

  // 2. If cached and not disabled
  if (!options.noCache && fs.existsSync(CACHE_FILE_PATH)) {
    try {
      console.log(`[INFO] Reading USITC data from local cache: ${CACHE_FILE_PATH}`);
      const raw = fs.readFileSync(CACHE_FILE_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    } catch {
      console.warn('[WARN] Failed to read cache, downloading fresh data...');
    }
  }

  const primaryUrl = options.url || PRIMARY_USITC_URL;
  console.log(`[INFO] Testing primary USITC endpoint: ${primaryUrl}`);

  const defaultHeaders = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
  };

  let data: UsitcRawItem[] | null = null;
  try {
    const res = await fetch(primaryUrl, {
      headers: defaultHeaders,
      signal: AbortSignal.timeout(15000),
    });

    if (res.ok) {
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json') || contentType.includes('octet-stream')) {
        const text = await res.text();
        const json = JSON.parse(text);
        if (Array.isArray(json)) {
          data = json;
          console.log(`[INFO] Successfully downloaded ${data.length} items from primary endpoint.`);
        }
      } else {
        console.warn(`[WARN] Primary endpoint returned status ${res.status} but unexpected content-type: ${contentType}`);
      }
    } else {
      console.warn(`[WARN] Primary endpoint returned HTTP status ${res.status}: ${res.statusText}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[WARN] Error fetching from primary endpoint: ${message}`);
  }

  // If primary endpoint failed or returned non-JSON, fallback to working exportList endpoint
  if (!data) {
    console.log(`[INFO] Falling back to active USITC export endpoint: ${FALLBACK_USITC_URL}`);
    const fallbackRes = await fetch(FALLBACK_USITC_URL, {
      headers: defaultHeaders,
      signal: AbortSignal.timeout(30000),
    });

    if (!fallbackRes.ok) {
      throw new Error(
        `Failed to download USITC dataset from fallback endpoint. Status: ${fallbackRes.status} ${fallbackRes.statusText}`
      );
    }

    const text = await fallbackRes.text();
    const json = JSON.parse(text);
    if (!Array.isArray(json)) {
      throw new Error(`Unexpected schema from fallback endpoint: expected JSON array, got ${typeof json}`);
    }
    data = json;
    console.log(`[INFO] Successfully downloaded ${data.length} raw entries from fallback endpoint.`);
  }

  // Save to cache directory
  try {
    const cacheDir = path.dirname(CACHE_FILE_PATH);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    fs.writeFileSync(CACHE_FILE_PATH, JSON.stringify(data));
    console.log(`[INFO] Saved downloaded dataset to cache: ${CACHE_FILE_PATH}`);
  } catch (cacheErr: unknown) {
    const message = cacheErr instanceof Error ? cacheErr.message : String(cacheErr);
    console.warn(`[WARN] Failed to write cache: ${message}`);
  }

  return data;
}

// Parse 6-digit HS codes and build hierarchical descriptions
export function parse6DigitCodes(rawItems: UsitcRawItem[]): ParsedHsEntry[] {
  const ancestorStack: { indent: number; desc: string; htsno: string }[] = [];
  const codeMap = new Map<string, ParsedHsEntry>();

  for (const item of rawItems) {
    const rawHts = (item.htsno || '').trim();
    const indent = parseInt(item.indent || '0', 10);
    const desc = cleanHtml(item.description);

    // Maintain hierarchical ancestor stack by indent
    while (ancestorStack.length > 0 && ancestorStack[ancestorStack.length - 1].indent >= indent) {
      ancestorStack.pop();
    }

    // Check if this item defines or belongs to a 6-digit HS code
    // Matches formats: "XXXX.XX", "XXXX.XX.YY", "XXXX.XX.YY.ZZ"
    const match = rawHts.match(/^(\d{4})\.(\d{2})/);
    if (match) {
      const code6 = `${match[1]}.${match[2]}`;

      if (!codeMap.has(code6)) {
        // Build description incorporating ancestral context for unambiguous semantics
        const ancestors = ancestorStack
          .map((a) => a.desc)
          .filter((d) => d && d.length > 0);

        const parts = [...ancestors, desc].filter((p) => p && p.length > 0);
        // Combine hierarchy with " - "
        const combinedDescription = parts.join(' - ');

        codeMap.set(code6, {
          hs_code: code6,
          official_description: combinedDescription || desc || `HS ${code6}`,
        });
      }
    }

    ancestorStack.push({ indent, desc, htsno: rawHts });
  }

  return Array.from(codeMap.values());
}

// Mock synthetic expansion generator
function mockExpandDescription(hsCode: string, officialDescription: string): string {
  // Deterministic mock expansion using keywords from description
  const words = officialDescription
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !['other', 'parts', 'thereof', 'than', 'having', 'with'].includes(w.toLowerCase()))
    .slice(0, 5);

  const keywords = words.length > 0 ? words.join(', ') : 'standard commercial product';
  const mockExpansion = `consumer goods, commercial retail products, ${keywords}, material variants for ${hsCode}`;

  return `${officialDescription}\n\nCommon products and variants: ${mockExpansion}`;
}

// Mock 768-dimensional unit embedding generator
function mockEmbedDescription(seedStr: string): number[] {
  // Deterministic Mulberry32 PRNG seeded from seedStr
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }

  const rand = () => {
    h = Math.imul(h ^ (h >>> 15), h | 1);
    h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
    return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
  };

  const dim = 768;
  const vec = new Float64Array(dim);
  let normSq = 0;

  for (let i = 0; i < dim; i++) {
    const val = (rand() - 0.5) * 2;
    vec[i] = val;
    normSq += val * val;
  }

  const norm = Math.sqrt(normSq) || 1;
  const result: number[] = new Array(dim);
  for (let i = 0; i < dim; i++) {
    result[i] = Number((vec[i] / norm).toFixed(6));
  }
  return result;
}

// Live Gemini call with retries and exponential backoff
async function callWithRetry<T>(fn: () => Promise<T>, maxRetries = 4, initialDelayMs = 1000): Promise<T> {
  let delay = initialDelayMs;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (attempt === maxRetries) throw err;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[WARN] API call failed (attempt ${attempt}/${maxRetries}): ${message}. Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
  throw new Error('Retries exhausted');
}

// Main execution pipeline
async function main() {
  const options = parseArgs();
  console.log('=== HS Code Classifier Corpus Loader ===');
  console.log(`Options: limit=${options.limit ?? 'none'}, mock=${options.mock}, dryRun=${options.dryRun}`);

  const apiKey = process.env.GEMINI_API_KEY;
  let useMock = options.mock;

  if (!apiKey || apiKey.trim() === '') {
    console.warn('[WARN] process.env.GEMINI_API_KEY is missing or empty.');
    console.warn('[WARN] Running in deterministic mock mode for synthetic expansion and embeddings.');
    useMock = true;
  }

  let genAI: GoogleGenerativeAI | null = null;
  if (!useMock && apiKey) {
    console.log('[INFO] Live Gemini API configured.');
    genAI = new GoogleGenerativeAI(apiKey);
  }

  // 1. Download & Parse
  console.log('\n--- Step 1: Downloading & Parsing USITC Dataset ---');
  const rawItems = await fetchUsitcDataset(options);
  console.log(`Total raw items in USITC export: ${rawItems.length}`);

  const parsedEntries = parse6DigitCodes(rawItems);
  console.log(`Total unique 6-digit HS codes discovered: ${parsedEntries.length}`);

  const entriesToProcess = options.limit ? parsedEntries.slice(0, options.limit) : parsedEntries;
  console.log(`Total codes to process in this run: ${entriesToProcess.length}`);

  // 2. Database connection
  let pool: Pool | null = null;
  if (!options.dryRun) {
    const databaseUrl = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL or DIRECT_DATABASE_URL is required when dryRun is false');
    }
    pool = new Pool({ connectionString: databaseUrl });
  }

  let existingSet = new Set<string>();
  if (!options.dryRun && pool) {
    const existingRes = await pool.query('SELECT hs_code FROM hs_corpus');
    existingSet = new Set(existingRes.rows.map((r: { hs_code: string }) => r.hs_code));
    console.log(`Already ingested codes in database: ${existingSet.size}`);
  }

  let processedCount = 0;
  let successCount = 0;
  let errorCount = 0;

  console.log('\n--- Step 2: Processing Expansions, Embeddings & Upserting ---');
  const startTime = Date.now();

  let quotaExhausted = false;
  const BATCH_SIZE = 5;
  for (let i = 0; i < entriesToProcess.length; i += BATCH_SIZE) {
    if (quotaExhausted) break;
    const batch = entriesToProcess.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (entry) => {
        if (quotaExhausted || existingSet.has(entry.hs_code)) {
          processedCount++;
          if (existingSet.has(entry.hs_code)) successCount++;
          return;
        }

        try {
          let expandedDescription = entry.official_description;

          // Synthetic expansion
          if (useMock || options.fast || !genAI) {
            expandedDescription = mockExpandDescription(entry.hs_code, entry.official_description);
          } else {
            const expansionModelName = process.env.CLASSIFICATION_MODEL || 'gemini-2.5-flash';
            const llmModel = genAI.getGenerativeModel({ model: expansionModelName });
            const prompt = `You are an expert in customs tariff classification (Harmonized System).
Given the official HS-6 description below, generate 3 to 5 common, plain-language consumer product names, search terms, and material variants that typically fall under this classification.
Output ONLY a comma-separated list of items without introductory text, numbering, or bullet points.

HS Code: ${entry.hs_code}
Official Description: ${entry.official_description}`;

            const expansionResult = await callWithRetry(async () => {
              const response = await llmModel.generateContent(prompt);
              return response.response.text().trim();
            });

            expandedDescription = `${entry.official_description}\n\nCommon products and variants: ${expansionResult}`;
          }

          // Embedding
          let embedding: number[];
          if (useMock || !genAI) {
            embedding = mockEmbedDescription(expandedDescription);
          } else {
            const embeddingModelName = process.env.EMBEDDING_MODEL || 'gemini-embedding-001';
            const embeddingModel = genAI.getGenerativeModel({ model: embeddingModelName });
            const embedResult = await callWithRetry(async () => {
              return await embeddingModel.embedContent(
                embeddingModelName.includes('gemini-embedding')
                  ? ({ content: { parts: [{ text: expandedDescription }] }, outputDimensionality: 768 } as any)
                  : expandedDescription
              );
            });

            embedding = embedResult.embedding.values;
            if (!embedding || embedding.length !== 768) {
              throw new Error(`Invalid embedding dimension: expected 768, got ${embedding ? embedding.length : 0}`);
            }
          }

          // Upsert into hs_corpus
          if (!options.dryRun && pool) {
            const embeddingPgVector = `[${embedding.join(',')}]`;
            await pool.query(
              `INSERT INTO hs_corpus (hs_code, description, embedding)
               VALUES ($1, $2, $3)
               ON CONFLICT (hs_code) DO UPDATE
               SET description = EXCLUDED.description,
                   embedding = EXCLUDED.embedding`,
              [entry.hs_code, expandedDescription, embeddingPgVector]
            );
          }

          successCount++;
        } catch (err: unknown) {
          errorCount++;
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes('Quota exceeded') || message.includes('QuotaFailure')) {
            quotaExhausted = true;
          }
          console.error(`[ERROR] Failed processing HS Code ${entry.hs_code}: ${message}`);
        } finally {
          processedCount++;
        }
      })
    );

    if (quotaExhausted) {
      console.log('\n[INFO] Daily free-tier quota reached for today. Safely stopping run.');
      console.log(`Currently stored in Neon: ${successCount} / ${entriesToProcess.length} codes (${((successCount / entriesToProcess.length) * 100).toFixed(1)}%).`);
      console.log(`Run 'npm run load-corpus:resume' when quota resets to continue smoothly.\n`);
      break;
    }

    // Progress logging
    if (processedCount % 100 === 0 || i + BATCH_SIZE >= entriesToProcess.length) {
      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
      const pct = (((processedCount) / entriesToProcess.length) * 100).toFixed(1);
      console.log(
        `[PROGRESS] ${pct}% - Processed ${processedCount}/${entriesToProcess.length} codes (${successCount} succeeded, ${errorCount} errors) in ${elapsedSec}s`
      );
    }
  }

  if (pool) {
    await pool.end();
  }

  const totalTimeSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n=== Corpus Loading Complete ===');
  console.log(`Total unique codes discovered: ${parsedEntries.length}`);
  console.log(`Processed in run: ${processedCount}`);
  console.log(`Successfully upserted: ${successCount}`);
  console.log(`Errors: ${errorCount}`);
  console.log(`Total duration: ${totalTimeSec}s`);
}

// Execute if run directly
if (require.main === module) {
  main().catch((err) => {
    console.error('[FATAL] Script execution failed:', err);
    process.exit(1);
  });
}
