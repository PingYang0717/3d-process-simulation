// 身分規則（plan v15 §7、M15.2）：值相同身分不變（useStable／sameScope／sameBBox）、handler 身分永遠相同（useEvent）、
// memoEd 只在 uses 的欄位變了才 render、DEV Proxy 抓到 render 期間讀了 uses 以外的欄位。
// 專案沒有 jsdom／testing-library：hook 層級用 react-dom/client ＋ act，掛在下面這個最小的假 DOM 上（只要 appendChild／createTextNode 這些就夠）。
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ReactNode, createElement, useState } from 'react';
import { act } from 'react';
import { sameScope } from '../../volume/scope';
import { sameBBox } from '../../volume/volume';
import { useStable } from '../../ui/stable';
import { useEvent } from '../../ui/useEvent';
import { memoEd, sameEdProps } from '../../ui/memoEd';
import type { Editor } from './editor';

// ---- 最小假 DOM（react-dom 只用到這些） ----
class FakeNode {
  nodeType: number;
  nodeName: string;
  tagName: string;
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  nodeValue = '';
  attrs: Record<string, string> = {};
  style: Record<string, string> = {};
  ownerDocument: unknown;
  constructor(nodeType: number, name: string) {
    this.nodeType = nodeType;
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
  }
  appendChild(c: FakeNode) {
    c.parentNode?.removeChild(c);
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  insertBefore(c: FakeNode, ref: FakeNode | null) {
    if (!ref) return this.appendChild(c);
    c.parentNode?.removeChild(c);
    c.parentNode = this;
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, c);
    return c;
  }
  removeChild(c: FakeNode) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling(): FakeNode | null {
    const p = this.parentNode;
    return p ? (p.childNodes[p.childNodes.indexOf(this) + 1] ?? null) : null;
  }
  get textContent(): string {
    return this.nodeType === 3 ? this.nodeValue : this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    if (this.nodeType === 3) this.nodeValue = v;
    else this.childNodes = v === '' ? [] : [doc.createTextNode(v)];
  }
  setAttribute(k: string, v: unknown) {
    this.attrs[k] = String(v);
  }
  removeAttribute(k: string) {
    delete this.attrs[k];
  }
  addEventListener() {}
  removeEventListener() {}
  contains(n: FakeNode): boolean {
    return n === this || this.childNodes.some((c) => c.contains(n));
  }
}
const doc = {
  nodeType: 9,
  nodeName: '#document',
  createElement: (t: string) => Object.assign(new FakeNode(1, t), { ownerDocument: doc }),
  createElementNS: (_ns: string, t: string) => Object.assign(new FakeNode(1, t), { ownerDocument: doc }),
  createTextNode: (t: string) => Object.assign(new FakeNode(3, '#text'), { nodeValue: t, ownerDocument: doc }),
  documentElement: null as unknown as FakeNode,
  body: null as unknown as FakeNode,
  activeElement: null as unknown,
  addEventListener() {},
  removeEventListener() {},
  defaultView: null as unknown,
};
doc.documentElement = doc.createElement('html');
doc.body = doc.createElement('body');
doc.documentElement.appendChild(doc.body);
doc.activeElement = doc.body;

type Root = { render: (el: ReactNode) => void; unmount: () => void };
let createRoot: (c: unknown) => Root;
const roots: Root[] = [];
const mount = (el: ReactNode) => {
  const host = doc.createElement('div');
  const root = createRoot(host);
  act(() => root.render(el));
  roots.push(root);
  return { host, rerender: (next: ReactNode) => act(() => root.render(next)) };
};

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window = globalThis;
  g.document = doc;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  // react-dom 的 getActiveElementDeep 會 instanceof window.HTMLIFrameElement
  g.HTMLIFrameElement = class HTMLIFrameElement {};
  doc.defaultView = globalThis;
  // react-dom 載入時看 window.document 判斷能不能用 DOM，所以要在設好假 DOM 之後才 import
  const m = await import('react-dom/client');
  createRoot = m.createRoot as unknown as typeof createRoot;
});
afterEach(() => {
  while (roots.length) act(() => roots.pop()!.unmount());
});

// ---- 純函式 ----

describe('sameScope / sameBBox', () => {
  it('值相同就相等、任何一欄不同就不等', () => {
    expect(sameScope({ axis: 'z', lo: 1, hi: 5 }, { axis: 'z', lo: 1, hi: 5 })).toBe(true);
    expect(sameScope({ axis: 'z', lo: 1, hi: 5 }, { axis: 'y', lo: 1, hi: 5 })).toBe(false);
    expect(sameScope({ axis: 'z', lo: 1, hi: 5 }, { axis: 'z', lo: 1, hi: 6 })).toBe(false);
    expect(sameScope(null, null)).toBe(true);
    expect(sameScope(null, { axis: 'z', lo: 1, hi: 5 })).toBe(false);
    const b = { x0: 1, x1: 2, y0: 3, y1: 4, z0: 5, z1: 6 };
    expect(sameBBox(b, { ...b })).toBe(true);
    expect(sameBBox(b, { ...b, z1: 7 })).toBe(false);
    expect(sameBBox(null, b)).toBe(false);
    expect(sameBBox(null, null)).toBe(true);
  });
});

describe('sameEdProps', () => {
  it('uses 的值逐一 Object.is，其他 props 淺比較', () => {
    const fn = () => {};
    const base = { ed: {} as Editor, __vals: [1, 'a', fn], __holder: {} as never, width: 240 };
    expect(sameEdProps(base, { ...base, __vals: [1, 'a', fn] })).toBe(true);
    expect(sameEdProps(base, { ...base, __vals: [2, 'a', fn] })).toBe(false);
    expect(sameEdProps(base, { ...base, __vals: [1, 'a', () => {}] })).toBe(false);
    expect(sameEdProps(base, { ...base, width: 241 })).toBe(false);
    expect(sameEdProps(base, { ...base, __vals: [NaN], width: 240 } as never)).toBe(false); // 長度不同
    expect(sameEdProps({ ...base, __vals: [NaN] }, { ...base, __vals: [NaN] })).toBe(true); // Object.is(NaN, NaN)
  });
});

// ---- hook 層級 ----

describe('useStable', () => {
  it('值相同回上一個物件、值不同換新', () => {
    const seen: { axis: string; lo: number; hi: number }[] = [];
    function C({ scope }: { scope: { axis: 'z'; lo: number; hi: number } }) {
      seen.push(useStable(scope, sameScope));
      return null;
    }
    const a = { axis: 'z' as const, lo: 0, hi: 9 };
    const r = mount(createElement(C, { scope: a }));
    r.rerender(createElement(C, { scope: { axis: 'z', lo: 0, hi: 9 } }));
    r.rerender(createElement(C, { scope: { axis: 'z', lo: 0, hi: 9 } }));
    expect(seen.length).toBe(3);
    expect(seen[1]).toBe(a);
    expect(seen[2]).toBe(a);
    r.rerender(createElement(C, { scope: { axis: 'z', lo: 1, hi: 9 } }));
    expect(seen[3]).not.toBe(a);
    expect(seen[3]).toEqual({ axis: 'z', lo: 1, hi: 9 });
  });
});

describe('useEvent', () => {
  it('身分永遠相同、呼叫時用最新的 fn', () => {
    const seen: ((x: number) => number)[] = [];
    function C({ k }: { k: number }) {
      seen.push(useEvent((x: number) => x * k));
      return null;
    }
    const r = mount(createElement(C, { k: 2 }));
    r.rerender(createElement(C, { k: 3 }));
    r.rerender(createElement(C, { k: 5 }));
    expect(seen[0]).toBe(seen[1]);
    expect(seen[1]).toBe(seen[2]);
    expect(seen[0](10)).toBe(50);
  });
});

/** 假的 Editor：只有測試會讀的幾個欄位。 */
const edOf = (o: Record<string, unknown>) => o as unknown as Editor;

describe('memoEd', () => {
  it('只有 uses 的欄位變了才 render；其他 props 淺比較；handler 讀到最新的 ed', () => {
    let renders = 0;
    let handler: (() => number) | null = null;
    function Impl({ ed, width }: { ed: Editor; width: number }) {
      renders++;
      handler = () => (ed as unknown as { cursor: number[] }).cursor[2];
      return createElement('div', null, `${(ed as unknown as { selCount: number }).selCount}:${width}`);
    }
    const M = memoEd(Impl, ['selCount'], 'TestA');
    const ed1 = edOf({ selCount: 1, cursor: [0, 0, 1], sel: new Set() });
    const r = mount(createElement(M, { ed: ed1, width: 100 }));
    expect(renders).toBe(1);
    // cursor 不在 uses：跳過 render，但 handler 透過 Proxy 讀到最新值
    r.rerender(createElement(M, { ed: edOf({ ...ed1, cursor: [0, 0, 7] }), width: 100 }));
    expect(renders).toBe(1);
    expect(handler!()).toBe(7);
    // selCount 在 uses：render
    r.rerender(createElement(M, { ed: edOf({ ...ed1, selCount: 2 }), width: 100 }));
    expect(renders).toBe(2);
    expect(r.host.textContent).toBe('2:100');
    // 其他 props 變了：render
    r.rerender(createElement(M, { ed: edOf({ ...ed1, selCount: 2 }), width: 120 }));
    expect(renders).toBe(3);
    expect(r.host.textContent).toBe('2:120');
  });

  it('DEV Proxy：render 期間讀了 uses 以外的欄位 → console.error；事件 handler 裡讀不算', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let after: (() => unknown) | null = null;
      function Impl({ ed }: { ed: Editor }) {
        const e = ed as unknown as { selCount: number; cursor: number[]; sel: Set<string> };
        after = () => e.sel.size; // handler：render 之後才讀
        return createElement('div', null, `${e.selCount}/${e.cursor.length}`);
      }
      const M = memoEd(Impl, ['selCount'], 'TestB');
      mount(createElement(M, { ed: edOf({ selCount: 1, cursor: [0, 0, 1], sel: new Set(['a']) }) }));
      const msgs = spy.mock.calls.map((c) => String(c[0]));
      expect(msgs.some((m) => m.includes('TestB') && m.includes('ed.cursor'))).toBe(true);
      expect(msgs.some((m) => m.includes('ed.sel '))).toBe(false);
      spy.mockClear();
      expect(after!()).toBe(1);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('子元件（沒有自己 memo）render 期間讀 ed 也算在父元件的 uses 裡', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      function Child({ ed }: { ed: Editor }) {
        return createElement('span', null, String((ed as unknown as { busy: string }).busy));
      }
      function Impl({ ed }: { ed: Editor }) {
        return createElement('div', null, createElement(Child, { ed }));
      }
      const M = memoEd(Impl, [], 'TestC');
      mount(createElement(M, { ed: edOf({ busy: 'x' }) }));
      expect(spy.mock.calls.some((c) => String(c[0]).includes('TestC 讀了 ed.busy'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('父元件的 state 變了、ed 沒變：memoEd 子元件不 render', () => {
    let renders = 0;
    function Impl({ ed }: { ed: Editor }) {
      renders++;
      return createElement('i', null, String((ed as unknown as { selCount: number }).selCount));
    }
    const M = memoEd(Impl, ['selCount'], 'TestD');
    const ed1 = edOf({ selCount: 1 });
    let bump: () => void = () => {};
    function Parent() {
      const [n, setN] = useState(0);
      bump = () => setN((x) => x + 1);
      return createElement('div', null, String(n), createElement(M, { ed: ed1 }));
    }
    const r = mount(createElement(Parent));
    act(() => bump());
    act(() => bump());
    expect(r.host.textContent).toBe('21');
    expect(renders).toBe(1);
  });
});
