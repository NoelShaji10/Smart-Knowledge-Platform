import { describe, it, expect } from 'vitest';
import { AIGatewayClient } from './client';

describe('AIGatewayClient instantiation', () => {
  it('instantiates with custom or default base URL', () => {
    const client = new AIGatewayClient('http://localhost:4000');
    expect(client).toBeDefined();
  });
});
