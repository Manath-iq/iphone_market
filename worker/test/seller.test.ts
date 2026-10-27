import { describe, expect, it } from 'vitest';
import { parseSellerPrice } from '../src/bot-seller';

describe('parseSellerPrice', () => {
  it('понимает цену в привычных записях', () => {
    expect(parseSellerPrice('15000')).toBe(15000);
    expect(parseSellerPrice('15 000 ₽')).toBe(15000);
    expect(parseSellerPrice('15к')).toBe(15000);
    expect(parseSellerPrice('2,5 тыс')).toBe(2500);
  });
  it('отбрасывает мусор', () => {
    expect(parseSellerPrice('дорого')).toBeNull();
    expect(parseSellerPrice('5')).toBeNull();
  });
});
