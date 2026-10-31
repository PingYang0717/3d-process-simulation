// 網格建構器（plan v9 P13）：可成長的 Float32Array ×3（倍增），每個 quad 直接寫兩個三角形，不配中間陣列。
// greedyMesh 與 greedyMeshChunk 共用；輸出和以前 number[] push 再轉 Float32Array 逐元素相同。
import type { MeshData } from './volume';

export class MeshBuilder {
  private pos: Float32Array;
  private nor: Float32Array;
  private col: Float32Array;
  private n = 0;
  quads = 0;
  constructor(quads = 256) {
    const len = quads * 18;
    this.pos = new Float32Array(len);
    this.nor = new Float32Array(len);
    this.col = new Float32Array(len);
  }
  private grow() {
    const len = this.pos.length * 2;
    const g = (a: Float32Array) => {
      const b = new Float32Array(len);
      b.set(a);
      return b;
    };
    this.pos = g(this.pos);
    this.nor = g(this.nor);
    this.col = g(this.col);
  }
  /**
   * 一個面：沿軸 d 的平面上，起點 (x0, x1, x2)、沿軸 u 寬 w、沿軸 v 高 h；sign = 法線朝 +d／−d；顏色 (r, g, b)。
   * 頂點順序和以前相同：朝 + 是 p0 p1 p2 p0 p2 p3，朝 − 是 p0 p2 p1 p0 p3 p2。
   */
  quad(d: number, u: number, v: number, x0: number, x1: number, x2: number, w: number, h: number, sign: number, r: number, g: number, b: number) {
    if (this.n + 18 > this.pos.length) this.grow();
    const P = this.pos;
    const N = this.nor;
    const C = this.col;
    // 四個角：p0 = x、p1 = x + w·u、p2 = x + w·u + h·v、p3 = x + h·v
    const uw0 = u === 0 ? w : 0;
    const uw1 = u === 1 ? w : 0;
    const uw2 = u === 2 ? w : 0;
    const vh0 = v === 0 ? h : 0;
    const vh1 = v === 1 ? h : 0;
    const vh2 = v === 2 ? h : 0;
    const order = sign > 0 ? ORDER_POS : ORDER_NEG;
    const n0 = d === 0 ? sign : 0;
    const n1 = d === 1 ? sign : 0;
    const n2 = d === 2 ? sign : 0;
    let o = this.n;
    for (let k = 0; k < 6; k++, o += 3) {
      const c = order[k];
      const hu = c === 1 || c === 2;
      const hv = c === 2 || c === 3;
      P[o] = x0 + (hu ? uw0 : 0) + (hv ? vh0 : 0);
      P[o + 1] = x1 + (hu ? uw1 : 0) + (hv ? vh1 : 0);
      P[o + 2] = x2 + (hu ? uw2 : 0) + (hv ? vh2 : 0);
      N[o] = n0;
      N[o + 1] = n1;
      N[o + 2] = n2;
      C[o] = r;
      C[o + 1] = g;
      C[o + 2] = b;
    }
    this.n = o;
    this.quads++;
  }
  /** 剛好大小的複本（可以 transfer）。 */
  finish(): MeshData {
    return { positions: this.pos.slice(0, this.n), normals: this.nor.slice(0, this.n), colors: this.col.slice(0, this.n), quads: this.quads };
  }
}
const ORDER_POS = [0, 1, 2, 0, 2, 3];
const ORDER_NEG = [0, 2, 1, 0, 3, 2];

/** 一格面的代碼（greedy 合併用）：正＝朝 +、負＝朝 −、BOTH＝兩面都有（a、b 各 15 位元）。 */
export const BOTH = 1 << 30;

/** 把一個合併好的面（代碼 c）寫進 builder：BOTH 時兩面都寫。colorOf 每面呼叫一次。 */
export function emitFaces(mb: MeshBuilder, c: number, d: number, u: number, v: number, x0: number, x1: number, x2: number, w: number, h: number, colorOf: (code: number) => [number, number, number]) {
  // 負值的二補數也帶著 bit 30，所以先看正負再看 BOTH
  if (c > 0 && c & BOTH) {
    let rgb = colorOf((c >> 15) & 0x7fff);
    mb.quad(d, u, v, x0, x1, x2, w, h, 1, rgb[0], rgb[1], rgb[2]);
    rgb = colorOf(c & 0x7fff);
    mb.quad(d, u, v, x0, x1, x2, w, h, -1, rgb[0], rgb[1], rgb[2]);
  } else if (c > 0) {
    const rgb = colorOf(c);
    mb.quad(d, u, v, x0, x1, x2, w, h, 1, rgb[0], rgb[1], rgb[2]);
  } else {
    const rgb = colorOf(-c);
    mb.quad(d, u, v, x0, x1, x2, w, h, -1, rgb[0], rgb[1], rgb[2]);
  }
}
