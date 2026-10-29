/** 帶正負號的數字：+3、−2、±0。 */
export const signed = (n: number, digits = 0) => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n).toFixed(digits);
