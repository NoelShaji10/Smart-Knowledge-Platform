import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('CI workflow configuration', () => {
  it('verifies .github/workflows/ci.yml exists and contains mandatory steps', () => {
    const ciPath = path.join(__dirname, '../.github/workflows/ci.yml');
    expect(fs.existsSync(ciPath)).toBe(true);

    const ciContent = fs.readFileSync(ciPath, 'utf8');
    expect(ciContent).toContain('pnpm typecheck');
    expect(ciContent).toContain('pnpm test');
    expect(ciContent).toContain('pnpm test:security');
    expect(ciContent).toContain('docker compose up -d');
  });
});
