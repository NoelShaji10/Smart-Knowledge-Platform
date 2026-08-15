import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Security Requirement 6: Route Boundary Enforcer', () => {
  it('ensures no normal API route in apps/api-server/src/routes imports getSystemDb directly', () => {
    const routesDir = path.resolve(__dirname, '../../apps/api-server/src/routes');
    expect(fs.existsSync(routesDir)).toBe(true);

    const files = fs.readdirSync(routesDir).filter((f) => f.endsWith('.ts'));
    const violations: string[] = [];

    for (const file of files) {
      const filePath = path.join(routesDir, file);
      const content = fs.readFileSync(filePath, 'utf8');

      if (content.includes('getSystemDb')) {
        violations.push(file);
      }
    }

    expect(
      violations,
      `Direct getSystemDb import violation in API route handlers: ${violations.join(', ')}. Normal API routes must use req.db for request-scoped operations.`,
    ).toEqual([]);
  });
});
