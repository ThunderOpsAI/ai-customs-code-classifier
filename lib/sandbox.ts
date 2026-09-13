import { v5 as uuidv5 } from 'uuid';
import { Candidate } from './classify';

export const SANDBOX_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

export interface SandboxSuccessBody {
  classification_id: string;
  tier: 'high' | 'medium';
  review_recommended: boolean;
  country_specific_codes: null;
  candidates: Candidate[];
}

export interface SandboxRefusalBody {
  classification_id: string;
  error: {
    code: 'INSUFFICIENT_DETAIL';
    message: string;
  };
}

export type SandboxResult =
  | {
      status: 200;
      tier: 'high' | 'medium';
      body: SandboxSuccessBody;
    }
  | {
      status: 422;
      tier: 'low';
      body: SandboxRefusalBody;
    };

export function handleSandbox(description: string): SandboxResult {
  const classificationId = uuidv5(description, SANDBOX_NAMESPACE);
  const normalized = description.trim().toLowerCase();

  switch (normalized) {
    case 'stainless steel mug':
      return {
        status: 200,
        tier: 'high',
        body: {
          classification_id: classificationId,
          tier: 'high',
          review_recommended: false,
          country_specific_codes: null,
          candidates: [
            {
              hs_code: '7323.93',
              description: 'Table, kitchen or other household articles, of stainless steel',
              rationale:
                'The item is described as a stainless steel mug, which falls under household stainless steel articles.',
              confidence_score: 0.88,
            },
          ],
        },
      };

    case 'cotton t-shirt':
      return {
        status: 200,
        tier: 'high',
        body: {
          classification_id: classificationId,
          tier: 'high',
          review_recommended: false,
          country_specific_codes: null,
          candidates: [
            {
              hs_code: '6109.10',
              description: 'T-shirts, singlets and other vests, of cotton, knitted or crocheted',
              rationale:
                'The item is described as a cotton t-shirt, which is classified under cotton knitted or crocheted apparel.',
              confidence_score: 0.85,
            },
          ],
        },
      };

    case 'wireless earbuds':
      return {
        status: 200,
        tier: 'medium',
        body: {
          classification_id: classificationId,
          tier: 'medium',
          review_recommended: true,
          country_specific_codes: null,
          candidates: [
            {
              hs_code: '8517.62',
              description:
                'Machines for the reception, conversion and transmission or regeneration of voice, images or other data',
              rationale: 'Wireless earbuds transmit and receive audio data wirelessly via Bluetooth.',
              confidence_score: 0.74,
            },
            {
              hs_code: '8518.30',
              description: 'Headphones and earphones, whether or not combined with a microphone',
              rationale: 'Earbuds are earphones designed to be worn in the ear.',
              confidence_score: 0.68,
            },
          ],
        },
      };

    case 'mystery item':
      return {
        status: 422,
        tier: 'low',
        body: {
          classification_id: classificationId,
          error: {
            code: 'INSUFFICIENT_DETAIL',
            message:
              'Unable to classify with sufficient confidence. Please provide more material or functional details.',
          },
        },
      };

    default:
      return {
        status: 200,
        tier: 'medium',
        body: {
          classification_id: classificationId,
          tier: 'medium',
          review_recommended: true,
          country_specific_codes: null,
          candidates: [
            {
              hs_code: '8479.89',
              description:
                'Other machines and mechanical appliances having individual functions, not specified or included elsewhere',
              rationale: 'Sandbox default candidate match based on product description.',
              confidence_score: 0.72,
            },
            {
              hs_code: '3926.90',
              description: 'Other articles of plastics and articles of other materials',
              rationale: 'Sandbox secondary candidate match based on product description.',
              confidence_score: 0.65,
            },
          ],
        },
      };
  }
}
