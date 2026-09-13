import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { authenticateRequest } from '@/lib/auth';
import { handleSandbox } from '@/lib/sandbox';
import {
  classify,
  validateInput,
  ValidationError,
  UpstreamError,
  ClassifyInput,
  ClassifyResult,
} from '@/lib/classify';
import {
  checkCreditBalance,
  deductCredits,
  refundCredits,
  logUsage,
  hashDescription,
} from '@/lib/billing';

function detectImageMime(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export async function POST(req: Request) {
  // 1. Auth verification
  const auth = await authenticateRequest(req, pool);
  if (!auth.success) {
    return auth.response;
  }

  // 2. Parse request body (JSON or multipart/form-data)
  const contentType = req.headers.get('content-type') || '';
  let description = '';
  let imageObj: { buffer: Buffer; mimeType: string } | null = null;

  try {
    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData();
      const descVal = formData.get('description');
      description = typeof descVal === 'string' ? descVal : '';

      const file = formData.get('image');
      if (file && typeof file === 'object' && 'arrayBuffer' in file) {
        const fileBlob = file as Blob;
        const arrayBuf = await fileBlob.arrayBuffer();
        if (arrayBuf.byteLength > 0) {
          const buf = Buffer.from(arrayBuf);
          const mime = fileBlob.type || detectImageMime(buf) || '';
          imageObj = { buffer: buf, mimeType: mime };
        }
      }
    } else {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return NextResponse.json(
          { error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON payload.' } },
          { status: 400 }
        );
      }

      description = body?.description;

      if (body?.image) {
        if (typeof body.image === 'string') {
          let base64Str = body.image.trim();
          let explicitMime: string | undefined = undefined;
          const dataUriMatch = base64Str.match(/^data:([^;]+);base64,(.+)$/i);
          if (dataUriMatch) {
            explicitMime = dataUriMatch[1];
            base64Str = dataUriMatch[2];
          }
          const buf = Buffer.from(base64Str, 'base64');
          const mime =
            explicitMime ||
            (typeof body.mime_type === 'string' ? body.mime_type : undefined) ||
            (typeof body.mimeType === 'string' ? body.mimeType : undefined) ||
            detectImageMime(buf) ||
            '';
          imageObj = { buffer: buf, mimeType: mime };
        } else if (typeof body.image === 'object') {
          const rawData = body.image.data || body.image.buffer;
          const buf = Buffer.isBuffer(rawData)
            ? rawData
            : typeof rawData === 'string'
            ? Buffer.from(rawData, 'base64')
            : Buffer.from(rawData);
          const mime =
            body.image.mimeType || body.image.mime_type || detectImageMime(buf) || '';
          imageObj = { buffer: buf, mimeType: mime };
        }
      }
    }
  } catch (parseErr) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Failed to parse request body.' } },
      { status: 400 }
    );
  }

  // 3. Validate input
  const input: ClassifyInput = {
    description,
    image: imageObj,
  };

  try {
    validateInput(input);
  } catch (valErr) {
    if (valErr instanceof ValidationError) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: valErr.message } },
        { status: 400 }
      );
    }
    throw valErr;
  }

  // 4. Sandbox routing (test_ keys)
  if (auth.context.prefix === 'test') {
    const sandboxResult = handleSandbox(description);
    return NextResponse.json(sandboxResult.body, { status: sandboxResult.status });
  }

  // 5. Production execution (prod_ keys)
  const cost = imageObj ? 2 : 1;
  const hasCredits = await checkCreditBalance(auth.context.account_id, cost, pool);
  if (!hasCredits) {
    return NextResponse.json(
      { error: { code: 'INSUFFICIENT_CREDITS', message: 'Insufficient credits.' } },
      { status: 402 }
    );
  }

  const startTime = Date.now();
  let classificationResult: ClassifyResult;

  try {
    classificationResult = await classify(input, pool);
  } catch (pipelineErr) {
    const latencyMs = Date.now() - startTime;
    const descHash = hashDescription(description);

    if (pipelineErr instanceof ValidationError) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: pipelineErr.message } },
        { status: 400 }
      );
    }

    if (pipelineErr instanceof UpstreamError) {
      return NextResponse.json(
        { error: { code: 'UPSTREAM_ERROR', message: pipelineErr.message } },
        {
          status: 503,
          headers: {
            'Retry-After': '10',
          },
        }
      );
    }

    // Unhandled pipeline failure
    console.error('Pipeline failure:', pipelineErr);
    return NextResponse.json(
      { error: { code: 'INTERNAL_SERVER_ERROR', message: 'Pipeline failure occurred.' } },
      { status: 500 }
    );
  }

  const latencyMs = Date.now() - startTime;
  const descHash = hashDescription(description);

  // Low confidence refusal: no credits deducted, return 422
  if (classificationResult.tier === 'low') {
    await logUsage(
      {
        accountId: auth.context.account_id,
        classificationId: classificationResult.classification_id,
        creditsDeducted: 0,
        status: 'success',
        tier: 'low',
        imageIncluded: !!imageObj,
        descriptionHash: descHash,
        latencyMs,
      },
      pool
    );

    return NextResponse.json(
      {
        classification_id: classificationResult.classification_id,
        error: {
          code: 'INSUFFICIENT_DETAIL',
          message:
            'Unable to classify with sufficient confidence. Please provide more material or functional details.',
        },
      },
      { status: 422 }
    );
  }

  // High or Medium confidence: deduct credits atomically
  let creditsDeducted = false;
  try {
    const remainingCredits = await deductCredits(auth.context.account_id, cost, pool);
    if (remainingCredits === null) {
      return NextResponse.json(
        { error: { code: 'INSUFFICIENT_CREDITS', message: 'Insufficient credits.' } },
        { status: 402 }
      );
    }
    creditsDeducted = true;

    await logUsage(
      {
        accountId: auth.context.account_id,
        classificationId: classificationResult.classification_id,
        creditsDeducted: cost,
        status: 'success',
        tier: classificationResult.tier,
        imageIncluded: !!imageObj,
        descriptionHash: descHash,
        latencyMs,
      },
      pool
    );

    return NextResponse.json(
      {
        classification_id: classificationResult.classification_id,
        tier: classificationResult.tier,
        review_recommended: classificationResult.review_recommended,
        country_specific_codes: null,
        candidates: classificationResult.candidates,
      },
      { status: 200 }
    );
  } catch (deductionOrLogErr) {
    // If failure happened after deduction, perform compensating transaction
    if (creditsDeducted) {
      try {
        await refundCredits(
          auth.context.account_id,
          cost,
          classificationResult.classification_id,
          pool
        );
      } catch (refundErr) {
        console.error('Failed compensating refund transaction:', refundErr);
      }
    }

    console.error('Error in post-classification processing:', deductionOrLogErr);
    return NextResponse.json(
      { error: { code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred.' } },
      { status: 500 }
    );
  }
}
