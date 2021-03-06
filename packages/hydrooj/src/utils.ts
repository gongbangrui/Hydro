import fs from 'fs';
import { Duplex } from 'stream';
import cluster from 'cluster';
import path from 'path';
import serialize from 'serialize-javascript';
import Lru from 'lru-cache';

declare global {
    interface StringConstructor {
        random: (digit?: number) => string;
    }
    interface ArrayConstructor {
        isDiff: (a: any[], b: any[]) => boolean;
    }
    interface Date {
        format: (fmt?: string) => string;
    }
    interface Math {
        sum: (...args: Array<number[] | number>) => number;
    }
    interface SetConstructor {
        isSuperset: (set: Set<any>, subset: Set<any>) => boolean;
        intersection: <T>(setA: Set<T>, setB: Set<T>) => Set<T>;
        union: <T>(setA: Set<T>, setB: Set<T>) => Set<T>;
    }
}

const lru = new Lru(1000);

export function lrucache(target: any, funcName: string, obj: any) {
    const originalMethod = obj.value;
    obj.value = function func(...args: any[]) {
        const key = serialize({ funcName, args });
        let val = lru.get(key);
        if (val) return val;
        val = originalMethod.call(this, ...args);
        lru.set(key, val);
        return val;
    };
    return obj;
}

if (!cluster.worker) {
    // @ts-ignore
    cluster.worker = { id: 0 };
}

const dict = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';

String.random = function random(digit = 32) {
    let str = '';
    for (let i = 1; i <= digit; i++) str += dict[Math.floor(Math.random() * 62)];
    return str;
};

Array.isDiff = function isDiff(a, b) {
    if (a.length !== b.length) return true;
    a.sort();
    b.sort();
    for (const i in a) {
        if (a[i] !== b[i]) return true;
    }
    return false;
};

Date.prototype.format = function formatDate(fmt = '%Y-%m-%d %H:%M:%S') {
    let m = this.getMonth() + 1;
    if (m < 10) m = `0${m}`;
    let d = this.getDate();
    if (d < 10) d = `0${d}`;
    let H = this.getHours();
    if (H < 10) H = `0${H}`;
    let M = this.getMinutes();
    if (M < 10) M = `0${M}`;
    let S = this.getSeconds();
    if (S < 10) S = `0${S}`;
    return fmt
        .replace('%Y', this.getFullYear())
        .replace('%m', m)
        .replace('%d', d)
        .replace('%H', H)
        .replace('%M', M)
        .replace('%S', S);
};

Math.sum = function sum(...args) {
    let s = 0;
    for (const i of args) {
        if (i instanceof Array) {
            for (const j of i) {
                s += j;
            }
        } else s += i;
    }
    return s;
};

Set.isSuperset = function isSuperset(set, subset) {
    for (const elem of subset) {
        if (!set.has(elem)) return false;
    }
    return true;
};

Set.union = function Union<T>(setA: Set<T>, setB: Set<T>) {
    const union = new Set(setA);
    for (const elem of setB) union.add(elem);
    return union;
};

Set.intersection = function Intersection<T>(setA: Set<T>, setB: Set<T>): Set<T> {
    const intersection = new Set();
    for (const elem of setB) {
        if (setA.has(elem)) intersection.add(elem);
    }
    // @ts-ignore
    return intersection;
};

export function folderSize(folderPath: string) {
    let size = 0;
    const _next = function a(p: string) {
        if (p) {
            const stats = fs.statSync(p);
            if (!stats.isDirectory() || stats.isSymbolicLink()) {
                if (!stats.isSymbolicLink()) size += stats.size;
            } else {
                size += stats.size;
                const files = fs.readdirSync(p);
                if (Array.isArray(files)) {
                    files.forEach((file) => {
                        _next(path.join(p, file));
                    });
                }
            }
        }
    };
    _next(folderPath);
    return size;
}

const TIME_RE = /^([0-9]+(?:\.[0-9]*)?)([mu]?)s?$/i;
const TIME_UNITS = { '': 1000, m: 1, u: 0.001 };
const MEMORY_RE = /^([0-9]+(?:\.[0-9]*)?)([kmg])b?$/i;
const MEMORY_UNITS = { k: 0.1, m: 1, g: 1024 };

export function parseTimeMS(str: string) {
    const match = TIME_RE.exec(str);
    if (!match) throw new Error(`${str} error parsing time`);
    return Math.floor(parseFloat(match[1]) * TIME_UNITS[match[2]]);
}

export function parseMemoryMB(str: string) {
    const match = MEMORY_RE.exec(str);
    if (!match) throw new Error(`${str} error parsing memory`);
    return Math.ceil(parseFloat(match[1]) * MEMORY_UNITS[match[2]]);
}

export function isClass(obj: any, strict = false) {
    if (typeof obj !== 'function') return false;
    const str = obj.toString();
    if (obj.prototype === undefined) return false;
    if (obj.prototype.constructor !== obj) return false;
    if (str.slice(0, 5) === 'class') return true;
    if (Object.getOwnPropertyNames(obj.prototype).length >= 2) return true;
    if (/^function\s+\(|^function\s+anonymous\(/.test(str)) return false;
    if (strict && /^function\s+[A-Z]/.test(str)) return true;
    if (/\b\(this\b|\bthis[.[]\b/.test(str)) {
        if (!strict || /classCallCheck\(this/.test(str)) return true;
        return /^function\sdefault_\d+\s*\(/.test(str);
    }
    return false;
}

export function streamToBuffer(stream): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const buffers = [];
        stream.on('error', reject);
        stream.on('data', (data) => buffers.push(data));
        stream.on('end', () => resolve(Buffer.concat(buffers)));
    });
}

export function bufferToStream(buffer: Buffer): NodeJS.ReadableStream {
    const stream = new Duplex();
    stream.push(buffer);
    stream.push(null);
    return stream;
}

export function buildProjection(fields: string[]): Record<string, 1> {
    const o = {};
    for (const k of fields) o[k] = 1;
    return o;
}

export function sleep(timeout: number) {
    return new Promise((resolve) => {
        setTimeout(() => {
            resolve();
        }, timeout);
    });
}

function deepen(modifyString: (source: string) => string) {
    function modifyObject<T>(source: T): T {
        if (typeof source !== 'object' || !source) return source;
        if (Array.isArray(source)) return source.map(modifyObject) as any;
        const result = {} as T;
        for (const key in source) {
            result[modifyString(key)] = modifyObject(source[key]);
        }
        return result;
    }

    return function t<T>(source: T): T {
        if (typeof source === 'string') {
            return modifyString(source) as any;
        }
        return modifyObject(source);
    };
}

export const camelCase = deepen((source) => source.replace(/[_-][a-z]/g, (str) => str.slice(1).toUpperCase()));
export const paramCase = deepen((source) => source.replace(/_/g, '-').replace(/(?<!^)[A-Z]/g, (str) => `-${str.toLowerCase()}`));
export const snakeCase = deepen((source) => source.replace(/-/g, '_').replace(/(?<!^)[A-Z]/g, (str) => `_${str.toLowerCase()}`));

interface ProblemSource {
    description?: string,
    input?: string,
    output?: string,
    samples?: [string, string][],
    hint?: string,
    source?: string,
}

export function buildContent(source: ProblemSource, type: 'markdown' | 'html' = 'markdown', translate?: Function) {
    const _ = translate || ((s: string) => s);
    return type === 'html'
        ? [
            ...source.description ? [`<h2>${_('Description')}</h2>`, source.description] : [],
            ...source.input ? [`<h2>${_('Input Format')}</h2>`, source.input] : [],
            ...source.output ? [`<h2>'${_('Output Format')}</h2>`, source.output] : [],
            ...(source.samples).map((sample, i) => [
                `<h2>${_('Sample Input')} ${i + 1}</h2><pre>`,
                sample[0],
                `</pre><h2>${_('Sample Output')} ${i + 1}</h2><pre>`,
                sample[1],
                '</pre>',
            ].join('\n')),
            ...source.hint ? [`<h2>${_('Hint')}</h2>`, source.hint] : [],
            ...source.source ? [`<h2>${_('Source')}</h2>`, source.source] : [],
        ].join('\n')
        : [
            ...source.description ? [`## ${_('Description')}`, source.description] : [],
            ...source.input ? [`## ${_('Input Format')}`, source.input] : [],
            ...source.output ? [`## '${_('Output Format')}`, source.output] : [],
            ...(source.samples).map((sample, i) => [
                `## ${_('Sample Input')} ${i + 1}`,
                '```',
                sample[0],
                '```',
                `## ${_('Sample Output')} ${i + 1}`,
                '```',
                sample[1],
                '```',
            ].join('\n')),
            ...source.hint ? [`## ${_('Hint')}`, source.hint] : [],
            ...source.source ? [`## ${_('Source')}`, source.source] : [],
        ].join('\n');
}
