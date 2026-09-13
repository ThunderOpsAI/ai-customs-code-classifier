import {
  calculateTier,
  filterCandidates,
  validateInput,
  classify,
  ValidationError,
  UpstreamError,
  TierThresholds,
  ClassifyInput,
} from '../lib/classify';
import { Pool } from 'pg';

describe('Step 3c: Confidence Math & Tier Assignment', () => {
  const defaultThresholds: TierThresholds = {
    confidenceFloor: 0.6,
    highConfidenceMargin: 0.15,
  };

  test('(a) 0 results → LOW', () => {
    const scores: number[] = [];
    const tier = calculateTier(scores, defaultThresholds);
    expect(tier).toBe('low');
  });

  test('(b) 1 result, score >= floor, margin = +Infinity → HIGH', () => {
    const scores = [0.85];
    const tier = calculateTier(scores, defaultThresholds);
    expect(tier).toBe('high');
  });

  test('(c) 1 result, score < floor → LOW', () => {
    const scores = [0.55];
    const tier = calculateTier(scores, defaultThresholds);
    expect(tier).toBe('low');
  });

  test('(d) 2 results, margin >= threshold and top >= floor → HIGH', () => {
    // top = 0.85 >= 0.60, margin = 0.85 - 0.65 = 0.20 >= 0.15
    const scores = [0.85, 0.65];
    const tier = calculateTier(scores, defaultThresholds);
    expect(tier).toBe('high');
  });

  test('(e) 2 results, margin < threshold, both above candidate min → MEDIUM', () => {
    // top = 0.75 >= 0.60, margin = 0.75 - 0.70 = 0.05 < 0.15
    const scores = [0.75, 0.7];
    const tier = calculateTier(scores, defaultThresholds);
    expect(tier).toBe('medium');
  });

  test('(f) Top score < floor → LOW', () => {
    // Even if margin is large, top score is below floor
    const scores = [0.58, 0.3];
    const tier = calculateTier(scores, defaultThresholds);
    expect(tier).toBe('low');
  });

  test('Boundary: top exactly equals confidenceFloor (0.60) and margin >= 0.15 → HIGH', () => {
    const scores = [0.6, 0.4];
    const tier = calculateTier(scores, defaultThresholds);
    expect(tier).toBe('high');
  });

  test('Boundary: margin exactly equals highConfidenceMargin (0.15) and top >= floor → HIGH', () => {
    const scores = [0.75, 0.6];
    const tier = calculateTier(scores, defaultThresholds);
    expect(tier).toBe('high');
  });

  test('Boundary: margin slightly below highConfidenceMargin (0.14) and top >= floor → MEDIUM', () => {
    const scores = [0.74, 0.6];
    const tier = calculateTier(scores, defaultThresholds);
    expect(tier).toBe('medium');
  });
});

describe('Step 3.0: Input Validation', () => {
  test('rejects missing or undefined description', () => {
    expect(() => validateInput({} as ClassifyInput)).toThrow(ValidationError);
    expect(() => validateInput({ description: undefined as any })).toThrow(ValidationError);
    expect(() => validateInput({ description: null as any })).toThrow(ValidationError);
  });

  test('rejects non-string description', () => {
    expect(() => validateInput({ description: 12345 as any })).toThrow(ValidationError);
    expect(() => validateInput({ description: 12345 as any })).toThrow(
      'description must be a string.'
    );
  });

  test('rejects description shorter than 10 characters', () => {
    expect(() => validateInput({ description: 'Short' })).toThrow(ValidationError);
    expect(() => validateInput({ description: '123456789' })).toThrow(
      'description must be at least 10 characters.'
    );
  });

  test('accepts description of exactly 10 characters', () => {
    expect(() => validateInput({ description: '1234567890' })).not.toThrow();
  });

  test('rejects description longer than 1000 characters', () => {
    const longDesc = 'a'.repeat(1001);
    expect(() => validateInput({ description: longDesc })).toThrow(ValidationError);
    expect(() => validateInput({ description: longDesc })).toThrow(
      'description cannot exceed 1000 characters.'
    );
  });

  test('accepts description of exactly 1000 characters', () => {
    const validDesc = 'a'.repeat(1000);
    expect(() => validateInput({ description: validDesc })).not.toThrow();
  });

  test('accepts valid image with jpeg, png, or webp under 5MB', () => {
    const buffer = Buffer.alloc(1024); // 1 KB
    expect(() =>
      validateInput({
        description: 'Stainless steel insulated water bottle 500ml',
        image: { buffer, mimeType: 'image/jpeg' },
      })
    ).not.toThrow();

    expect(() =>
      validateInput({
        description: 'Stainless steel insulated water bottle 500ml',
        image: { buffer, mimeType: 'image/png' },
      })
    ).not.toThrow();

    expect(() =>
      validateInput({
        description: 'Stainless steel insulated water bottle 500ml',
        image: { buffer, mimeType: 'image/webp' },
      })
    ).not.toThrow();
  });

  test('rejects unsupported image mime types', () => {
    const buffer = Buffer.alloc(1024);
    expect(() =>
      validateInput({
        description: 'Stainless steel insulated water bottle 500ml',
        image: { buffer, mimeType: 'image/gif' },
      })
    ).toThrow('image mime type must be image/jpeg, image/png, or image/webp.');

    expect(() =>
      validateInput({
        description: 'Stainless steel insulated water bottle 500ml',
        image: { buffer, mimeType: 'application/pdf' },
      })
    ).toThrow(ValidationError);
  });

  test('rejects image exceeding 5MB', () => {
    const largeBuffer = Buffer.alloc(5 * 1024 * 1024 + 1); // 5MB + 1 byte
    expect(() =>
      validateInput({
        description: 'Stainless steel insulated water bottle 500ml',
        image: { buffer: largeBuffer, mimeType: 'image/jpeg' },
      })
    ).toThrow('image size cannot exceed 5 MB.');
  });
});

describe('Step 3d: Candidate Filtering', () => {
  const mockCandidates = [
    { hs_code: '7323.93', description: 'Stainless steel table/kitchen articles', score: 0.88 },
    { hs_code: '9617.00', description: 'Vacuum flasks and vessels', score: 0.74 },
    { hs_code: '3924.10', description: 'Tableware and kitchenware of plastics', score: 0.65 },
    { hs_code: '7615.10', description: 'Table, kitchen articles of aluminum', score: 0.58 },
    { hs_code: '7013.10', description: 'Glassware of glass-ceramics', score: 0.45 },
  ];

  test('HIGH tier returns top result only', () => {
    const filtered = filterCandidates('high', mockCandidates, {
      minScore: 0.6,
      maxMedium: 3,
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].hs_code).toBe('7323.93');
  });

  test('MEDIUM tier returns results >= minScore capped at maxMedium', () => {
    const filtered = filterCandidates('medium', mockCandidates, {
      minScore: 0.6,
      maxMedium: 3,
    });
    expect(filtered).toHaveLength(3);
    expect(filtered.map((c) => c.hs_code)).toEqual(['7323.93', '9617.00', '3924.10']);
    expect(filtered.every((c) => c.score >= 0.6)).toBe(true);
  });

  test('MEDIUM tier respects maxMedium limit even if more qualify', () => {
    const filtered = filterCandidates('medium', mockCandidates, {
      minScore: 0.5,
      maxMedium: 2,
    });
    expect(filtered).toHaveLength(2);
    expect(filtered[0].hs_code).toBe('7323.93');
    expect(filtered[1].hs_code).toBe('9617.00');
  });

  test('LOW tier returns empty array', () => {
    const filtered = filterCandidates('low', mockCandidates, {
      minScore: 0.6,
      maxMedium: 3,
    });
    expect(filtered).toHaveLength(0);
    expect(filtered).toEqual([]);
  });
});

describe('Pipeline Integration: classify() with dependency injection', () => {
  const mockPool = {
    query: jest.fn(),
  } as unknown as Pool;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('End-to-end HIGH tier classification', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({
      rows: [
        { hs_code: '7323.93', description: 'Stainless steel kitchenware', score: 0.88 },
        { hs_code: '9617.00', description: 'Vacuum flasks', score: 0.65 },
      ],
    });

    const mockCaption = jest.fn();
    const mockEmbedding = jest.fn().mockResolvedValueOnce(new Array(768).fill(0.01));
    const mockRationales = jest.fn().mockResolvedValueOnce({
      '7323.93': 'Matches stainless steel household articles.',
    });

    const result = await classify(
      { description: 'Insulated double-walled stainless steel flask 500ml' },
      mockPool,
      {
        classificationId: 'test-id-1234',
        generateCaption: mockCaption,
        generateEmbedding: mockEmbedding,
        generateRationales: mockRationales,
      }
    );

    expect(mockCaption).not.toHaveBeenCalled();
    expect(mockEmbedding).toHaveBeenCalledTimes(1);
    expect(mockRationales).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      classification_id: 'test-id-1234',
      tier: 'high',
      review_recommended: false,
      country_specific_codes: null,
      candidates: [
        {
          hs_code: '7323.93',
          description: 'Stainless steel kitchenware',
          rationale: 'Matches stainless steel household articles.',
          confidence_score: 0.88,
        },
      ],
      image_included: false,
    });
  });

  test('End-to-end MEDIUM tier classification with image inclusion', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({
      rows: [
        { hs_code: '7323.93', description: 'Stainless steel kitchenware', score: 0.74 },
        { hs_code: '9617.00', description: 'Vacuum flasks', score: 0.7 },
      ],
    });

    const mockCaption = jest.fn().mockResolvedValueOnce('Metallic double wall thermos bottle');
    const mockEmbedding = jest.fn().mockResolvedValueOnce(new Array(768).fill(0.01));
    const mockRationales = jest.fn().mockResolvedValueOnce({
      '7323.93': 'Stainless steel construction fits 7323.93.',
      '9617.00': 'Vacuum flask design fits 9617.00.',
    });

    const buffer = Buffer.alloc(512);
    const result = await classify(
      {
        description: 'Double walled thermos bottle with screw cap',
        image: { buffer, mimeType: 'image/jpeg' },
      },
      mockPool,
      {
        classificationId: 'test-id-5678',
        generateCaption: mockCaption,
        generateEmbedding: mockEmbedding,
        generateRationales: mockRationales,
      }
    );

    expect(mockCaption).toHaveBeenCalledTimes(1);
    expect(mockEmbedding).toHaveBeenCalledWith(
      'Double walled thermos bottle with screw cap\nMetallic double wall thermos bottle'
    );
    expect(result.tier).toBe('medium');
    expect(result.review_recommended).toBe(true);
    expect(result.image_included).toBe(true);
    expect(result.candidates).toHaveLength(2);
  });

  test('End-to-end LOW tier returns refusal immediately without calling rationale generator', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({
      rows: [
        { hs_code: '7323.93', description: 'Stainless steel kitchenware', score: 0.52 },
        { hs_code: '9617.00', description: 'Vacuum flasks', score: 0.48 },
      ],
    });

    const mockEmbedding = jest.fn().mockResolvedValueOnce(new Array(768).fill(0.01));
    const mockRationales = jest.fn();

    const result = await classify(
      { description: 'Vague metallic item for household use' },
      mockPool,
      {
        classificationId: 'test-id-refusal',
        generateEmbedding: mockEmbedding,
        generateRationales: mockRationales,
      }
    );

    expect(mockRationales).not.toHaveBeenCalled();
    expect(result.tier).toBe('low');
    expect(result.review_recommended).toBe(true);
    expect(result.candidates).toEqual([]);
  });

  test('Upstream error on embedding failure throws UpstreamError (503)', async () => {
    const mockEmbedding = jest.fn().mockRejectedValueOnce(new Error('Network failure'));

    await expect(
      classify(
        { description: 'Valid product description here for error test' },
        mockPool,
        {
          generateEmbedding: mockEmbedding,
        }
      )
    ).rejects.toThrow(UpstreamError);
  });
});
