/* 本物の Code.gs を Node で動かすための、Apps Script まわりの最小の作りもの。
 *
 * 目的は「本物のコードをそのまま走らせて確かめる」こと。
 * Sheets の細かい挙動まで真似はしないが、実際に踏んだ落とし穴だけは再現する:
 *   - 枠（行数・列数）の外を getRange するとエラーになる
 *   - getLastRow は「何か入っている最後の行」
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CODE = path.join(__dirname, '..', 'gas', 'Code.gs');

function blank(rows, cols) {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => ''));
}
const isEmpty = (v) => v === '' || v === null || v === undefined;

class Range {
  constructor(sheet, row, col, nRows, nCols) {
    this.sh = sheet; this.row = row; this.col = col;
    this.nRows = nRows; this.nCols = nCols;
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.nRows; r++) {
      const line = [];
      for (let c = 0; c < this.nCols; c++) line.push(this.sh.cells[this.row - 1 + r][this.col - 1 + c]);
      out.push(line);
    }
    return out;
  }
  setValues(vals) {
    if (vals.length !== this.nRows) throw new Error('setValues: 行数が合いません');
    for (let r = 0; r < this.nRows; r++) {
      if (vals[r].length !== this.nCols) throw new Error('setValues: 列数が合いません');
      for (let c = 0; c < this.nCols; c++) this.sh.cells[this.row - 1 + r][this.col - 1 + c] = vals[r][c];
    }
    return this;
  }
  setValue(v) {
    for (let r = 0; r < this.nRows; r++)
      for (let c = 0; c < this.nCols; c++) this.sh.cells[this.row - 1 + r][this.col - 1 + c] = v;
    return this;
  }
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
  setBackground() { return this; }
  sort() { return this; }
}

class Sheet {
  constructor(name, rows = 100, cols = 26) {
    this.name = name;
    this.maxRows = rows; this.maxCols = cols;
    this.cells = blank(rows, cols);
  }
  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  getLastRow() {
    for (let r = this.maxRows - 1; r >= 0; r--)
      if (this.cells[r].some((v) => !isEmpty(v))) return r + 1;
    return 0;
  }
  getLastColumn() {
    for (let c = this.maxCols - 1; c >= 0; c--)
      if (this.cells.some((row) => !isEmpty(row[c]))) return c + 1;
    return 0;
  }
  getRange(row, col, nRows = 1, nCols = 1) {
    if (row < 1 || col < 1) throw new Error('セル範囲の座標または大きさが正しくありません');
    if (row + nRows - 1 > this.maxRows || col + nCols - 1 > this.maxCols)
      throw new Error('セル範囲の座標または大きさが正しくありません');
    return new Range(this, row, col, nRows, nCols);
  }
  appendRow(vals) {
    const r = this.getLastRow() + 1;
    if (r > this.maxRows) this.insertRowsAfter(this.maxRows, r - this.maxRows);
    if (vals.length > this.maxCols) this.insertColumnsAfter(this.maxCols, vals.length - this.maxCols);
    for (let c = 0; c < vals.length; c++) this.cells[r - 1][c] = vals[c];
    return this;
  }
  deleteRow(r) {
    this.cells.splice(r - 1, 1);
    this.cells.push(Array.from({ length: this.maxCols }, () => ''));
    return this;
  }
  insertRowsAfter(after, n) {
    for (let i = 0; i < n; i++) this.cells.splice(after + i, 0, Array.from({ length: this.maxCols }, () => ''));
    this.maxRows += n;
    return this;
  }
  insertColumnsAfter(after, n) {
    this.cells.forEach((row) => { for (let i = 0; i < n; i++) row.splice(after + i, 0, ''); });
    this.maxCols += n;
    return this;
  }
  deleteColumns(from, n) {
    this.cells.forEach((row) => row.splice(from - 1, n));
    this.maxCols -= n;
    return this;
  }
  deleteRows(from, n) {
    this.cells.splice(from - 1, n);
    for (let i = 0; i < n; i++) this.cells.push(Array.from({ length: this.maxCols }, () => ''));
    return this;
  }
  setFrozenRows() { return this; }
  autoResizeColumn() { return this; }
  autoResizeColumns() { return this; }
  setColumnWidth() { return this; }
  setColumnWidths() { return this; }
  hideColumns() { return this; }
  clear() { this.cells = blank(this.maxRows, this.maxCols); return this; }
  clearContents() { return this.clear(); }
  getFrozenRows() { return 1; }
}

class Spreadsheet {
  constructor() { this.sheets = []; }
  getName() { return '健康ログ（テスト）'; }
  getId() { return 'test-spreadsheet-id'; }
  getUrl() { return 'https://example.invalid/test'; }
  getSheetByName(n) { return this.sheets.filter((s) => s.getName() === n)[0] || null; }
  insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
  getSheets() { return this.sheets.slice(); }
}

function makeSandbox(opts = {}) {
  const now = new Date(opts.now || Date.now());
  let seq = 0;

  const ss = new Spreadsheet();
  const props = {};
  const cache = {};
  const net = { fetches: [], reply: () => ({ code: 200, body: '{}' }) };

  const pad = (n, w = 2) => String(n).padStart(w, '0');
  // TZ は Asia/Tokyo 固定でよい（Code.gs がそう指定している）
  const jst = (d) => new Date(d.getTime() + 9 * 3600 * 1000);

  const g = {
    console,
    Logger: { log: () => {} },
    SpreadsheetApp: { openById: () => ss, flush: () => {} },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: (k) => { delete props[k]; },
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (k in cache ? cache[k] : null),
        put: (k, v) => { cache[k] = String(v); },
      }),
    },
    LockService: {
      getScriptLock: () => ({ waitLock: () => true, releaseLock: () => {} }),
    },
    Utilities: {
      getUuid: () => 'uuid-' + (++seq),
      formatDate: (d, tz, fmt) => {
        const t = jst(d);
        return fmt
          .replace('yyyy', t.getUTCFullYear())
          .replace('MM', pad(t.getUTCMonth() + 1))
          .replace('dd', pad(t.getUTCDate()))
          .replace('HH', pad(t.getUTCHours()))
          .replace('mm', pad(t.getUTCMinutes()))
          .replace('ss', pad(t.getUTCSeconds()));
      },
      base64Encode: (s) => Buffer.from(s, 'utf8').toString('base64'),
      base64Decode: (s) => Array.from(Buffer.from(s, 'base64')),
    },
    UrlFetchApp: {
      fetch: (url, params) => {
        net.fetches.push({ url, params });
        const r = net.reply(url, params);
        return {
          getResponseCode: () => r.code,
          getContentText: () => r.body,
        };
      },
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (t) => ({ setMimeType: () => ({ getContent: () => t }, { getContent: () => t }) , getContent: () => t }),
    },
    Date: class extends Date {
      constructor(...a) { if (!a.length) super(now.getTime()); else super(...a); }
      static now() { return now.getTime(); }
    },
  };
  g.globalThis = g;

  const ctx = vm.createContext(g);
  vm.runInContext(fs.readFileSync(CODE, 'utf8'), ctx, { filename: 'Code.gs' });

  return { sandbox: g, ss, props, cache, net };
}

module.exports = { makeSandbox };
