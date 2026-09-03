import { describe, it, expect } from 'vitest';
import { calculateReadingTime, WORDS_PER_MINUTE } from '../components/editor/EditorStatusBar';

describe('Phase 3 T6: Editor Statistics & Reading Time Tests', () => {
  describe('calculateReadingTime Helper', () => {
    it('returns "0 min read" for 0 or negative word counts', () => {
      expect(calculateReadingTime(0)).toBe('0 min read');
      expect(calculateReadingTime(-10)).toBe('0 min read');
    });

    it('returns "< 1 min read" for word counts between 1 and WORDS_PER_MINUTE (200)', () => {
      expect(calculateReadingTime(1)).toBe('< 1 min read');
      expect(calculateReadingTime(50)).toBe('< 1 min read');
      expect(calculateReadingTime(199)).toBe('< 1 min read');
      expect(calculateReadingTime(200)).toBe('< 1 min read');
    });

    it('calculates rounded-up minutes for word counts exceeding 200 words', () => {
      expect(calculateReadingTime(201)).toBe('2 min read');
      expect(calculateReadingTime(400)).toBe('2 min read');
      expect(calculateReadingTime(401)).toBe('3 min read');
      expect(calculateReadingTime(1000)).toBe('5 min read');
    });
  });

  describe('Constant Definitions', () => {
    it('uses standard 200 words-per-minute baseline', () => {
      expect(WORDS_PER_MINUTE).toBe(200);
    });
  });
});
