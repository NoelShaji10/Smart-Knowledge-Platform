import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('AGENTS.md governance documentation', () => {
  it('verifies AGENTS.md exists at root and contains mandatory project rules', () => {
    const agentsPath = path.join(__dirname, '../AGENTS.md');
    expect(fs.existsSync(agentsPath)).toBe(true);

    const content = fs.readFileSync(agentsPath, 'utf8');
    expect(content).toContain('docs/ARCHITECTURE.md');
    expect(content).toContain('Rule 1: Authoritative Documents');
    expect(content).toContain('Rule 2: Security & Isolation Invariants');
    expect(content).toContain('Rule 3: Worker Idempotency');
    expect(content).toContain('Rule 4: Surgical Modifications');
  });
});
