import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { rateLimitMiddleware } from './middleware/rate-limit.js';
import { exchangeRouter } from './routes/exchange.js';
import { infoRouter } from './routes/info.js';
import { hypaperRouter } from './routes/hypaper.js';
import { logger } from '../utils/logger.js';

export const app = new Hono();

// Global middleware
app.use('*', cors());

// Global error handler
app.onError((err, c) => {
  if (err instanceof SyntaxError && err.message.includes('JSON')) {
    return c.json({ error: 'Invalid or missing JSON body' }, 400);
  }
  logger.error({ err }, 'Unhandled error');
  return c.json({ error: 'Internal server error' }, 500);
});

// Health check
app.get('/health', (c) => c.json({ status: 'ok', time: Date.now() }));

// Basic response for the bare API domain
app.get('/', (c) => c.json({
  status: 'ok',
  service: 'hypaper-api',
  endpoints: ['/health', '/info', '/exchange', '/hypaper'],
}));

// Helpful response for wrong method
const postOnlyMsg = { error: 'This endpoint only accepts POST with a JSON body. See: POST /info {"type":"allMids"}' };
app.get('/info', (c) => c.json(postOnlyMsg, 405));
app.get('/exchange', (c) => c.json(postOnlyMsg, 405));
app.get('/hypaper', (c) => c.json(postOnlyMsg, 405));

// Rate limiting for API routes
app.use('/exchange', rateLimitMiddleware);
app.use('/info', rateLimitMiddleware);
app.use('/hypaper', rateLimitMiddleware);

// Routes
app.route('/exchange', exchangeRouter);
app.route('/info', infoRouter);
app.route('/hypaper', hypaperRouter);
