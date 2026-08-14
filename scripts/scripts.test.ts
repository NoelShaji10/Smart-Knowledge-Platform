import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('infrastructure setup scripts and docker-compose', () => {
  it('verifies docker-compose.yml exists and contains all 5 infrastructure services', () => {
    const composePath = path.join(__dirname, '../docker-compose.yml');
    expect(fs.existsSync(composePath)).toBe(true);

    const composeContent = fs.readFileSync(composePath, 'utf8');
    expect(composeContent).toContain('postgres:');
    expect(composeContent).toContain('redis:');
    expect(composeContent).toContain('qdrant:');
    expect(composeContent).toContain('minio:');
    expect(composeContent).toContain('litellm:');
  });

  it('verifies setup scripts exist', () => {
    expect(fs.existsSync(path.join(__dirname, '../scripts/dev-setup.sh'))).toBe(true);
    expect(fs.existsSync(path.join(__dirname, '../scripts/health-check.sh'))).toBe(true);
  });
});
