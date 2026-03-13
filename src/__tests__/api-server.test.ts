import { describe, expect, it } from 'vitest';
import { app } from '../api/server.js';

describe('api server', () => {
  it('returns a basic response at the root path', async () => {
    const res = await app.request('/');
    const body = await res.json() as {
      status: string;
      service: string;
      endpoints: string[];
    };

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      status: 'ok',
      service: 'hypaper-api',
    });
    expect(body.endpoints).toContain('/health');
  });
});
