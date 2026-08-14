import { describe, it, expect } from 'vitest';
import { createApiApp } from './app';

describe('api-server application setup', () => {
  it('instantiates express app with routes configured', () => {
    const app = createApiApp();
    expect(app).toBeDefined();
  });
});
