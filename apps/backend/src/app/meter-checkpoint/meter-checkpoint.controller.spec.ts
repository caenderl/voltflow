import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { parseReadAt } from './meter-checkpoint.controller';

describe('parseReadAt', () => {
  it('accepts a HH:MM time of day', () => {
    expect(parseReadAt('18:00')).toBe('18:00');
    expect(parseReadAt('00:00')).toBe('00:00');
    expect(parseReadAt('23:59')).toBe('23:59');
  });

  it('drops the seconds browsers append once they are involved', () => {
    expect(parseReadAt('13:11:20')).toBe('13:11');
  });

  it('rejects a missing time instead of assuming one', () => {
    // The whole point of the field: no reading time means no comparison.
    expect(() => parseReadAt(undefined)).toThrow(BadRequestException);
    expect(() => parseReadAt(null)).toThrow(BadRequestException);
    expect(() => parseReadAt('')).toThrow(BadRequestException);
  });

  it('rejects malformed and out-of-range times', () => {
    expect(() => parseReadAt('9:05')).toThrow(BadRequestException); // unpadded
    expect(() => parseReadAt('18-00')).toThrow(BadRequestException);
    expect(() => parseReadAt('abc')).toThrow(BadRequestException);
    expect(() => parseReadAt('24:00')).toThrow(BadRequestException);
    expect(() => parseReadAt('12:60')).toThrow(BadRequestException);
  });
});
