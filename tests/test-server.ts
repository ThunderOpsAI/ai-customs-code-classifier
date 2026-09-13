import http from 'http';
import { POST as classifyHandler } from '@/app/api/v1/classify/route';
import { POST as feedbackHandler } from '@/app/api/v1/feedback/route';
import { POST as stripeWebhookHandler } from '@/app/api/webhooks/stripe/route';

/**
 * Creates a native Node http.Server that maps incoming HTTP requests
 * to Next.js App Router route handlers using Web Standard Request/Response.
 */
export function createTestServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      const protocol = 'http';
      const host = req.headers.host || 'localhost';
      const url = new URL(req.url || '/', `${protocol}://${host}`);
      const pathname = url.pathname;

      // Collect request stream body chunks
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const bodyBuffer = Buffer.concat(chunks);

      // Convert Node IncomingHttpHeaders to Web Standard Headers
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) {
          for (const v of value) {
            headers.append(key, v);
          }
        } else if (value !== undefined) {
          headers.set(key, value);
        }
      }

      // Web standard Request rejects body on GET/HEAD
      const canHaveBody = req.method !== 'GET' && req.method !== 'HEAD';
      const webReq = new Request(url.toString(), {
        method: req.method,
        headers,
        body: canHaveBody && bodyBuffer.length > 0 ? bodyBuffer : undefined,
        // @ts-ignore Node.js specific RequestInit property
        duplex: 'half',
      });

      let webRes: Response;

      if ((pathname === '/api/v1/classify' || pathname === '/v1/classify') && req.method === 'POST') {
        webRes = await classifyHandler(webReq);
      } else if ((pathname === '/api/v1/feedback' || pathname === '/v1/feedback') && req.method === 'POST') {
        webRes = await feedbackHandler(webReq);
      } else if ((pathname === '/api/webhooks/stripe' || pathname === '/webhooks/stripe') && req.method === 'POST') {
        webRes = await stripeWebhookHandler(webReq);
      } else {
        webRes = new Response(
          JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Route not found' } }),
          { status: 404, headers: { 'content-type': 'application/json' } }
        );
      }

      // Write Web Response back to http.ServerResponse
      res.statusCode = webRes.status;
      webRes.headers.forEach((val, key) => {
        res.setHeader(key, val);
      });

      if (webRes.status === 204 || !webRes.body) {
        res.end();
      } else {
        const arrayBuf = await webRes.arrayBuffer();
        res.end(Buffer.from(arrayBuf));
      }
    } catch (err: any) {
      console.error('Test server error dispatching route:', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            error: {
              code: 'INTERNAL_SERVER_ERROR',
              message: err?.message || 'Server error',
            },
          })
        );
      }
    }
  });

  return server;
}
