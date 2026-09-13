import { Pool } from 'pg';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { v4 as uuidv4 } from 'uuid';

export interface ClassifyInput {
  description: string;
  image?: {
    buffer: Buffer;
    mimeType: string;
  } | null;
}

export interface Candidate {
  hs_code: string;
  description: string;
  rationale: string;
  confidence_score: number;
}

export type ClassificationTier = 'high' | 'medium' | 'low';

export interface ClassifyResult {
  classification_id: string;
  tier: ClassificationTier;
  review_recommended: boolean;
  country_specific_codes: null;
  candidates: Candidate[];
  image_included: boolean;
}

export class UpstreamError extends Error {
  readonly code = 'UPSTREAM_ERROR';
  readonly statusCode = 503;
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export class ValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export interface TierThresholds {
  confidenceFloor: number;
  highConfidenceMargin: number;
}

export interface ClassifyOptions {
  classificationId?: string;
  generateCaption?: (image: { buffer: Buffer; mimeType: string }) => Promise<string>;
  generateEmbedding?: (text: string) => Promise<number[]>;
  generateRationales?: (
    candidates: Array<{ hs_code: string; description: string; score: number }>,
    userInput: string
  ) => Promise<Record<string, string>>;
  thresholds?: TierThresholds;
  candidateMinScore?: number;
  maxMediumCandidates?: number;
  retrievalTopK?: number;
}

/**
 * Step 3.0: Input Validation (Pre-Pipeline Gate)
 * Validates input prior to database or LLM invocation.
 */
export function validateInput(input: ClassifyInput): void {
  if (!input || input.description === undefined || input.description === null) {
    throw new ValidationError('description is required.');
  }
  if (typeof input.description !== 'string') {
    throw new ValidationError('description must be a string.');
  }
  if (input.description.length < 10) {
    throw new ValidationError('description must be at least 10 characters.');
  }
  if (input.description.length > 1000) {
    throw new ValidationError('description cannot exceed 1000 characters.');
  }
  if (input.image !== undefined && input.image !== null) {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!input.image.mimeType || !allowedMimeTypes.includes(input.image.mimeType)) {
      throw new ValidationError('image mime type must be image/jpeg, image/png, or image/webp.');
    }
    const maxBytes = 5 * 1024 * 1024;
    if (!input.image.buffer || input.image.buffer.length > maxBytes) {
      throw new ValidationError('image size cannot exceed 5 MB.');
    }
  }
}

/**
 * Helper to enforce a 15-second timeout on upstream operations
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs = 15000, operationName = 'Upstream operation'): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new UpstreamError(`${operationName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } catch (err: unknown) {
    if (err instanceof UpstreamError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new UpstreamError(`${operationName} failed: ${message}`);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Step 3c: Confidence Math & Tier Assignment
 */
export function calculateTier(
  scores: number[],
  thresholds: TierThresholds
): ClassificationTier {
  if (scores.length === 0) {
    return 'low';
  }
  let top = scores[0];
  let margin: number;
  if (scores.length === 1) {
    margin = Infinity;
  } else {
    margin = scores[0] - scores[1];
  }

  if (top < thresholds.confidenceFloor) {
    return 'low';
  } else if (margin >= thresholds.highConfidenceMargin) {
    return 'high';
  } else {
    return 'medium';
  }
}

/**
 * Step 3d: Candidate Filtering (Between Retrieval and Rationale)
 */
export function filterCandidates(
  tier: ClassificationTier,
  results: Array<{ hs_code: string; description: string; score: number }>,
  config: { minScore: number; maxMedium: number }
): Array<{ hs_code: string; description: string; score: number }> {
  if (tier === 'high') {
    return results.length > 0 ? [results[0]] : [];
  }
  if (tier === 'medium') {
    return [...results]
      .filter((r) => r.score >= config.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, config.maxMedium);
  }
  return [];
}

/**
 * Main classification pipeline function implementing Steps 3.0 through 3e.
 */
export async function classify(
  input: ClassifyInput,
  pool: Pool,
  options?: ClassifyOptions
): Promise<ClassifyResult> {
  // Step 3.0: Input Validation
  validateInput(input);

  const classificationId = options?.classificationId || uuidv4();
  const imageIncluded = Boolean(input.image && input.image.buffer);

  let genAI: GoogleGenerativeAI | null = null;
  const getGenAI = (): GoogleGenerativeAI => {
    if (!genAI) {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new UpstreamError('GEMINI_API_KEY environment variable is not configured');
      }
      genAI = new GoogleGenerativeAI(apiKey);
    }
    return genAI;
  };

  // Step 3a: Image Pre-Processing (if image provided)
  let unifiedQuery = input.description;
  if (imageIncluded && input.image) {
    let caption: string;
    if (options?.generateCaption) {
      caption = await withTimeout(
        options.generateCaption(input.image),
        15000,
        'Image captioning'
      );
    } else {
      caption = await withTimeout(
        (async () => {
          const ai = getGenAI();
          const modelName = process.env.CAPTIONING_MODEL || 'gemini-2.5-flash';
          const model = ai.getGenerativeModel({ model: modelName });
          const response = await model.generateContent([
            {
              inlineData: {
                data: input.image!.buffer.toString('base64'),
                mimeType: input.image!.mimeType,
              },
            },
            'Extract a concise, plain-text physical description and material estimate of the product shown in this image.',
          ]);
          return response.response.text();
        })(),
        15000,
        'Image captioning'
      );
    }

    if (caption && caption.trim().length > 0) {
      unifiedQuery = `${input.description}\n${caption.trim()}`;
    }
  }

  // Step 3b: Retrieval
  let embeddingValues: number[];
  if (options?.generateEmbedding) {
    embeddingValues = await withTimeout(
      options.generateEmbedding(unifiedQuery),
      15000,
      'Embedding generation'
    );
  } else {
    embeddingValues = await withTimeout(
      (async () => {
        const ai = getGenAI();
        const embeddingModelName = process.env.EMBEDDING_MODEL || 'gemini-embedding-001';
        const model = ai.getGenerativeModel({ model: embeddingModelName });
        const res = await model.embedContent(
          embeddingModelName.includes('gemini-embedding')
            ? ({ content: { parts: [{ text: unifiedQuery }] }, outputDimensionality: 768 } as any)
            : unifiedQuery
        );
        return res.embedding.values;
      })(),
      15000,
      'Embedding generation'
    );
  }

  const retrievalTopK = options?.retrievalTopK ?? parseInt(process.env.RETRIEVAL_TOP_K || '5', 10);
  const embeddingVectorStr = `[${embeddingValues.join(',')}]`;

  const query = `SELECT hs_code, description, 1 - (embedding <=> $1::vector) AS score FROM hs_corpus ORDER BY embedding <=> $1::vector LIMIT $2`;
  const dbResult = await pool.query(query, [embeddingVectorStr, retrievalTopK]);
  const retrievedResults: Array<{ hs_code: string; description: string; score: number }> = dbResult.rows.map((row) => ({
    hs_code: row.hs_code as string,
    description: row.description as string,
    score: parseFloat(row.score),
  }));

  // Step 3c: Confidence Math & Tier Assignment
  const thresholds: TierThresholds = options?.thresholds ?? {
    confidenceFloor: parseFloat(process.env.CONFIDENCE_FLOOR || '0.60'),
    highConfidenceMargin: parseFloat(process.env.HIGH_CONFIDENCE_MARGIN || '0.15'),
  };
  const scores = retrievedResults.map((r) => r.score);
  const tier = calculateTier(scores, thresholds);

  // Step 3d: Candidate Filtering
  const candidateMinScore = options?.candidateMinScore ?? parseFloat(process.env.CANDIDATE_MIN_SCORE || '0.60');
  const maxMediumCandidates = options?.maxMediumCandidates ?? parseInt(process.env.MAX_MEDIUM_CANDIDATES || '3', 10);
  const filteredCandidates = filterCandidates(tier, retrievedResults, {
    minScore: candidateMinScore,
    maxMedium: maxMediumCandidates,
  });

  // Step 3e: Rationale Generation
  let candidates: Candidate[] = [];
  if (tier !== 'low' && filteredCandidates.length > 0) {
    let rationalesMap: Record<string, string> = {};

    if (options?.generateRationales) {
      rationalesMap = await withTimeout(
        options.generateRationales(filteredCandidates, input.description),
        15000,
        'Rationale generation'
      );
    } else {
      rationalesMap = await withTimeout(
        (async () => {
          const ai = getGenAI();
          const modelName = process.env.CLASSIFICATION_MODEL || 'gemini-2.5-flash';
          const model = ai.getGenerativeModel({
            model: modelName,
            generationConfig: {
              responseMimeType: 'application/json',
            },
          });

          const candidatesPrompt = filteredCandidates
            .map((c, i) => `${i + 1}. HS Code: ${c.hs_code}\nDescription: ${c.description}`)
            .join('\n\n');

          const prompt = `You are an expert in customs tariff classification.
Product description: ${input.description}
${imageIncluded ? `Unified query details: ${unifiedQuery}` : ''}

Candidate HS codes:
${candidatesPrompt}

For each candidate HS code listed above, provide a concise 1-2 sentence rationale explaining why the product fits each code based on user input.
IMPORTANT: You MUST NOT re-rank or reorder the candidate codes.

Return a JSON array of objects with the following schema:
[
  {
    "hs_code": "<exact HS code>",
    "rationale": "<1-2 sentence rationale>"
  }
]`;

          const response = await model.generateContent(prompt);
          const responseText = response.response.text();
          const parsed = JSON.parse(responseText);
          const map: Record<string, string> = {};
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              if (item && item.hs_code && typeof item.rationale === 'string') {
                map[item.hs_code] = item.rationale;
              }
            }
          }
          return map;
        })(),
        15000,
        'Rationale generation'
      );
    }

    candidates = filteredCandidates.map((c) => ({
      hs_code: c.hs_code,
      description: c.description,
      rationale: rationalesMap[c.hs_code] || `Product matches description for HS code ${c.hs_code}.`,
      confidence_score: c.score,
    }));
  }

  return {
    classification_id: classificationId,
    tier,
    review_recommended: tier !== 'high',
    country_specific_codes: null,
    candidates,
    image_included: imageIncluded,
  };
}
