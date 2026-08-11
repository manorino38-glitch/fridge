/*******************************************************************************
 * 食材在庫＆食費管理アプリ  —  GAS バックエンド
 *
 * データ置き場: 既存スプレッドシート「健康ログ」に以下のシートを追加する。
 *   食材マスタ / 仕入 / 消費 / 在庫外支出 / 設定
 *   （既存の log・栄養・食事・体組成 シートには一切触らない）
 *
 * 使い方:
 *   1) setup() を1回実行する（シート作成＋トークン発行）
 *      既存データがあるときは、列構成の変更を自動で移行する
 *   2) デプロイ > 新しいデプロイ > 種類「ウェブアプリ」
 *      実行ユーザー: 自分 / アクセスできるユーザー: 全員
 *
 * 設計メモ:
 *   - 日付は 'yyyy-MM-dd' の文字列で保持する。「健康ログ」のlogシートと
 *     同じ形式なので、あとから日付キーで突き合わせられる（仕様書 7-3）。
 *   - 食事区分も列として持つ。あすけんの食事シートと
 *     「日付 + 食事区分」で結合できる粒度に揃えてある（同上）。
 *   - 「作り置きへ振替」の消費行は食費に計上しない（仕様書 6-3）。
 *   - 数量の単位は食材ごとに持つ（g / ml / 個 / 本 / 枚 / 自由入力）。
 *     %の計算は単位に依存しないので、仕組みは共通のまま。
 ******************************************************************************/

/** 「健康ログ」のスプレッドシートID */
const SS_ID = '16e0KVWcksP87e_bsSPxMKfN9PiftOjXgzYHzlsSUWhI';

const TZ = 'Asia/Tokyo';

const SHEETS = {
  foods: '食材マスタ',
  lots:  '仕入',
  cons:  '消費',
  out:   '在庫外支出',
  conf:  '設定',
};

const HEADERS = {
  foods: ['食材ID', '品名', '表記ゆれ', '置き場カテゴリ', '単位', '在庫管理する', '前回の量', '前回の円', '更新日時'],
  lots:  ['ロットID', '日付', '食材ID', '品名', '単位', '内容量', '金額', '円/単位', '残量', '状態', '由来', '作成日時'],
  cons:  ['消費ID', '日時', '日付', 'ロットID', '食材ID', '品名', '単位', '使用量', '金額', '食事区分', '種別', '振替先ロットID', '作成日時'],
  out:   ['支出ID', '日付', '区分', '店名・品名', '金額', '食事区分', '由来', '作成日時'],
  conf:  ['キー', '値'],
};

/** 旧列名 → 新列名。setup() のときに自動で移行する */
const RENAMED = {
  '内容量g': '内容量',
  '残量g':   '残量',
  '使用量g': '使用量',
  '前回のg': '前回の量',
  '円/g':    '円/単位',
};

/** 列を足したときの既定値 */
const COL_DEFAULT = { '単位': 'g' };

/** 文字列のまま保持したい列（勝手に日付や数値に変換されるのを防ぐ） */
const TEXT_HEADERS = [
  '食材ID', 'ロットID', '消費ID', '支出ID', '振替先ロットID',
  '日付', '日時', '更新日時', '作成日時', 'キー', '単位',
];

/** 数値として保持したい列。
 *  書式を明示しないと、309 のような値がシリアル値と解釈されて
 *  「1900-11-04」のような日付で表示されてしまうことがある。 */
const NUMBER_HEADERS = ['内容量', '金額', '円/単位', '残量', '使用量', '前回の量', '前回の円'];

const DEFAULT_CATEGORIES = ['野菜室', 'チルド', '冷蔵', '冷凍庫', 'ドアポケット', '常温', '作り置き'];

/** 在庫外支出の区分。設定シートで変更できる */
const DEFAULT_OUT_KINDS = ['外食', '飲料', '調味料', '米', '菓子', 'その他'];

/** 単位の候補。ここにないものはアプリ側で自由入力できる */
const DEFAULT_UNITS = ['g', 'ml', '個', '本', '枚'];

const KIND = {
  use:   '消費',
  waste: '廃棄',
  adj:   '使い切り調整',
  prep:  '作り置きへ振替',
};

const MEALS = ['朝', '昼', '夕', '間食'];

/** 作り置きロットの内容量。%で管理するため常に100 */
const PREP_UNIT = 100;
const PREP_UNIT_LABEL = '%';


/* =============================================================================
 * セットアップ / 移行
 * ===========================================================================*/

function setup() {
  const changed = [];
  Object.keys(SHEETS).forEach(function (k) {
    const sh = sheet_(k);
    if (migrate_(k)) changed.push(SHEETS[k]);
    // 表示形式の付け直し。金額が日付として表示されてしまった列を元に戻す
    applyFormats_(sheet_(k), HEADERS[k]);
  });

  if (getConf_('categories') === null) setConf_('categories', DEFAULT_CATEGORIES.join(','));
  if (getConf_('outKinds')   === null) setConf_('outKinds',   DEFAULT_OUT_KINDS.join(','));
  if (getConf_('units')      === null) setConf_('units',      DEFAULT_UNITS.join(','));

  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('APP_TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('APP_TOKEN', token);
  }

  // レシート読取は外部に通信する。ここで一度呼んでおくと、
  // 必要な権限（script.external_request）の同意画面がこのタイミングで出る。
  // 承認が済んでいないと、アプリ側から読み取ろうとしたときだけ失敗して分かりにくい。
  let net = '';
  try {
    UrlFetchApp.fetch('https://generativelanguage.googleapis.com/', { muteHttpExceptions: true });
    net = '外部通信の権限: OK';
  } catch (e) {
    net = '外部通信の権限: まだです（レシート読取だけ使えません）→ ' + (e && e.message ? e.message : e);
  }

  const msg = [
    '',
    '=== セットアップ完了 ===',
    'スプレッドシート: ' + ss_().getName(),
    changed.length ? '列構成を移行したシート: ' + changed.join(' / ') : '列構成の移行は不要でした',
    net,
    '',
    'APIトークン（アプリの設定画面に貼る）:',
    '  ' + token,
    '',
  ].join('\n');
  Logger.log(msg);
  return msg;
}

function showToken() {
  const t = PropertiesService.getScriptProperties().getProperty('APP_TOKEN');
  Logger.log(t || '(未発行。setup() を実行してください)');
  return t;
}

function rotateToken() {
  const t = Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('APP_TOKEN', t);
  Logger.log(t);
  return t;
}

/**
 * 列構成が変わったときに、既存の行を壊さず並べ替える。
 * 列名で対応づけるので、列の追加・改名・並び替えのどれでも通る。
 * 何度実行しても結果は同じ（すでに新しい形なら何もしない）。
 */
function migrate_(key) {
  const sh = sheet_(key);
  const want = HEADERS[key];
  const width = Math.max(sh.getLastColumn(), want.length);
  const cur = sh.getRange(1, 1, 1, width).getValues()[0]
                .map(function (v) { return String(v).trim(); })
                .filter(function (v) { return v !== ''; });

  if (cur.length === want.length && cur.every(function (v, i) { return v === want[i]; })) return false;

  const last = sh.getLastRow();
  const rows = last > 1 ? sh.getRange(2, 1, last - 1, cur.length).getValues() : [];

  // 旧行を「列名 -> 値」に開いてから、新しい並びに詰め直す
  const remapped = rows
    .filter(function (r) { return String(r[0]).trim() !== ''; })
    .map(function (r) {
      const o = {};
      cur.forEach(function (h, i) {
        o[h] = r[i];
        if (RENAMED[h]) o[RENAMED[h]] = r[i];
      });
      return want.map(function (h) {
        if (o[h] !== undefined && o[h] !== '') return o[h];
        if (COL_DEFAULT[h] !== undefined) {
          // 作り置きのロットだけは単位が%
          if (h === '単位' && String(o['由来']) === '作り置き') return PREP_UNIT_LABEL;
          if (h === '単位' && String(o['置き場カテゴリ']) === '作り置き') return PREP_UNIT_LABEL;
          return COL_DEFAULT[h];
        }
        return o[h] !== undefined ? o[h] : '';
      });
    });

  sh.clear();
  ensureRoom_(sh, Math.max(2, remapped.length + 1), want.length);
  sh.getRange(1, 1, 1, want.length).setValues([want]).setFontWeight('bold').setBackground('#f1f3f4');
  sh.setFrozenRows(1);
  applyFormats_(sh, want);
  if (remapped.length) sh.getRange(2, 1, remapped.length, want.length).setValues(remapped);
  sh.autoResizeColumns(1, want.length);
  return true;
}


/* =============================================================================
 * エントリポイント
 * ===========================================================================*/

function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  if (action) {
    return jsonOut_(handle_({
      action: action,
      token: e.parameter.token,
      payload: e.parameter.payload ? JSON.parse(e.parameter.payload) : {},
    }));
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('冷蔵庫')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * JSON API 本体。
 * fetch側は Content-Type: text/plain で投げること。
 * （application/json にするとCORSプリフライトが発生し、GASは応答できない）
 */
function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); }
  catch (err) { return jsonOut_({ ok: false, error: 'リクエストを解釈できませんでした' }); }
  return jsonOut_(handle_(req));
}

/** google.script.run 経由の呼び出し口（GASがHTMLも配信しているとき用） */
function api(reqJson) {
  return JSON.stringify(handle_(JSON.parse(reqJson)));
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
                       .setMimeType(ContentService.MimeType.JSON);
}


/* =============================================================================
 * ルーティング
 * ===========================================================================*/

function handle_(req) {
  try {
    const expected = PropertiesService.getScriptProperties().getProperty('APP_TOKEN');
    if (!expected) return { ok: false, error: 'setup() が未実行です' };
    if (String(req.token || '') !== expected) return { ok: false, error: 'トークンが違います', authFailed: true };

    const p = req.payload || {};

    // 同じ操作が二重に届いたら握りつぶす（電波が悪いときの再送対策）
    if (req.opId) {
      const cache = CacheService.getScriptCache();
      const hit = cache.get('op:' + req.opId);
      if (hit) return JSON.parse(hit);
      const res = dispatch_(req.action, p);
      if (res && res.ok) cache.put('op:' + req.opId, JSON.stringify(res), 21600);
      return res;
    }
    return dispatch_(req.action, p);

  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err), stack: String(err && err.stack || '') };
  }
}

function dispatch_(action, p) {
  switch (action) {
    case 'bootstrap':     return apiBootstrap_(p);
    case 'summary':       return apiSummary_(p);
    case 'day':           return { ok: true, day: buildDay_(p.date || today_()) };
    case 'addFood':       return apiAddFood_(p);
    case 'updateFood':    return apiUpdateFood_(p);
    case 'addLots':       return apiAddLots_(p);
    case 'record':        return apiRecord_(p);
    case 'addExpense':    return apiAddExpense_(p);
    case 'undo':          return apiUndo_(p);
    case 'setCategories': return apiSetConf_('categories', p.categories);
    case 'setOutKinds':   return apiSetConf_('outKinds', p.outKinds);
    case 'setUnits':      return apiSetConf_('units', p.units);
    case 'readReceipt':   return apiReadReceipt_(p);
    case 'setOcrKey':     return apiSetOcrKey_(p);
    case 'ocrStatus':     return apiOcrStatus_(p);
    case 'ping':          return { ok: true, at: nowStr_() };
    default:              return { ok: false, error: '不明なaction: ' + action };
  }
}


/* =============================================================================
 * API 実装
 * ===========================================================================*/

function apiBootstrap_(p) {
  const foods = readAll_('foods');
  const lots  = readAll_('lots');

  const lastBuy = {};
  lots.forEach(function (l) {
    const fid = String(l['食材ID']);
    const d = d2s_(l['日付']);
    if (!lastBuy[fid] || d > lastBuy[fid]) lastBuy[fid] = d;
  });

  const foodOut = foods.map(function (f) {
    const o = foodOut_(f);
    o.lastBuy = lastBuy[o.id] || '';
    return o;
  });

  const stock = lots
    .filter(function (l) { return String(l['状態']) === '在庫あり' && num_(l['残量']) > 0; })
    .map(lotOut_);

  return {
    ok: true,
    serverDate: today_(),
    serverTime: nowStr_(),
    categories: getListConf_('categories', DEFAULT_CATEGORIES),
    outKinds:   getListConf_('outKinds',   DEFAULT_OUT_KINDS),
    units:      getListConf_('units',      DEFAULT_UNITS),
    meals: MEALS,
    foods: foodOut,
    lots: stock,
    summary: buildSummary_(p.ym || today_().slice(0, 7)),
    day: buildDay_(today_()),
    ocr: { hasKey: !!ocrKey_() },
  };
}

function apiSummary_(p) {
  return { ok: true, summary: buildSummary_(p.ym || today_().slice(0, 7)), day: buildDay_(today_()) };
}

function apiAddFood_(p) {
  const name = String(p.name || '').trim();
  if (!name) return { ok: false, error: '品名が空です' };

  const foods = readAll_('foods');
  const dup = foods.filter(function (f) { return String(f['品名']) === name; })[0];
  if (dup) return { ok: true, food: foodOut_(dup), duplicated: true };

  const id = newId_('F');
  const row = rowFor_('foods', {
    '食材ID': id,
    '品名': name,
    '表記ゆれ': String(p.aliases || ''),
    '置き場カテゴリ': String(p.category || getListConf_('categories', DEFAULT_CATEGORIES)[0]),
    '単位': String(p.unit || 'g'),
    '在庫管理する': p.tracked === false ? false : true,
    '前回の量': p.lastQty != null ? num_(p.lastQty) : '',
    '前回の円': p.lastYen != null ? num_(p.lastYen) : '',
    '更新日時': nowStr_(),
  });
  const shF = sheet_('foods');
  ensureRoom_(shF, shF.getLastRow() + 1, HEADERS.foods.length);
  shF.appendRow(row);

  return { ok: true, food: {
    id: id, name: name, aliases: String(p.aliases || ''),
    category: row[idx_('foods', '置き場カテゴリ')],
    unit: row[idx_('foods', '単位')],
    tracked: true, lastQty: num_(p.lastQty), lastYen: num_(p.lastYen), lastBuy: '',
  } };
}

function apiUpdateFood_(p) {
  const sh = sheet_('foods');
  const r = findRow_(sh, col_('foods', '食材ID'), String(p.id));
  if (r < 0) return { ok: false, error: '食材が見つかりません' };

  const w = HEADERS.foods.length;
  const cur = sh.getRange(r, 1, 1, w).getValues()[0];
  const set = function (h, v) { cur[idx_('foods', h)] = v; };

  if (p.name     != null) set('品名', String(p.name));
  if (p.aliases  != null) set('表記ゆれ', String(p.aliases));
  if (p.category != null) set('置き場カテゴリ', String(p.category));
  if (p.unit     != null) set('単位', String(p.unit));
  if (p.tracked  != null) set('在庫管理する', !!p.tracked);
  set('更新日時', nowStr_());
  sh.getRange(r, 1, 1, w).setValues([cur]);

  // 単位を変えたら、在庫が残っているロットの表示単位も合わせる
  if (p.unit != null && p.applyToStock !== false) {
    const shLots = sheet_('lots');
    readAll_('lots').forEach(function (l) {
      if (String(l['食材ID']) !== String(p.id)) return;
      if (String(l['状態']) !== '在庫あり') return;
      shLots.getRange(l._row, col_('lots', '単位')).setValue(String(p.unit));
    });
  }

  const foods = readAll_('foods');
  const hit = foods.filter(function (f) { return String(f['食材ID']) === String(p.id); })[0];
  return { ok: true, food: hit ? foodOut_(hit) : null };
}

/**
 * 仕入登録。まとめて複数件受け取れる（レシートOCRで一括生成する将来の口・仕様書7-1）。
 * 日付は呼び出し側が自由に指定できる＝過去日付も入れられる（仕様書7-2）。
 */
function apiAddLots_(p) {
  const items = p.items || [];
  if (!items.length) return { ok: false, error: '登録するものがありません' };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const shLots  = sheet_('lots');
    const shFoods = sheet_('foods');
    const byId = {};
    readAll_('foods').forEach(function (f) { byId[String(f['食材ID'])] = f; });

    const rows = [], created = [], now = nowStr_();

    items.forEach(function (it) {
      const food = byId[String(it.foodId)];
      if (!food) throw new Error('食材IDが不明です: ' + it.foodId);

      const qty = num_(it.qty);
      const yen = num_(it.yen);
      if (!(qty > 0)) throw new Error(food['品名'] + ' の内容量が0です');

      const unit = String(it.unit || food['単位'] || 'g');
      const perU = yen / qty;
      const id = newId_('L');
      const date = it.date ? d2s_(it.date) : today_();

      rows.push(rowFor_('lots', {
        'ロットID': id, '日付': date, '食材ID': String(it.foodId), '品名': String(food['品名']),
        '単位': unit, '内容量': qty, '金額': yen, '円/単位': perU, '残量': qty,
        '状態': '在庫あり', '由来': String(it.source || '手入力'), '作成日時': now,
      }));
      created.push({
        id: id, date: date, foodId: String(it.foodId), name: String(food['品名']),
        unit: unit, qty: qty, yen: yen, perU: perU, remain: qty,
        status: '在庫あり', source: String(it.source || '手入力'),
      });

      // 次回の初期値として控えておく（仕様書5-3の「前回値」）
      const fr = findRow_(shFoods, col_('foods', '食材ID'), String(it.foodId));
      if (fr > 0) {
        setCell_(shFoods, fr, col_('foods', '前回の量'), qty, '0.############');
        setCell_(shFoods, fr, col_('foods', '前回の円'), yen, '0.############');
        setCell_(shFoods, fr, col_('foods', '更新日時'), now, '@');

        // レシートの表記が自分の呼び方と違ったら、表記ゆれとして覚えておく。
        // 次に同じ店で同じ品物を買ったとき、一発で当たるようになる
        const merged = addAlias_(String(food['表記ゆれ']), String(it.alias || ''), String(food['品名']));
        if (merged !== null) {
          setCell_(shFoods, fr, col_('foods', '表記ゆれ'), merged, '@');
          food['表記ゆれ'] = merged;
        }
      }
    });

    const at = shLots.getLastRow() + 1;
    ensureRoom_(shLots, at + rows.length - 1, HEADERS.lots.length);
    shLots.getRange(at, 1, rows.length, HEADERS.lots.length).setValues(rows);
    return { ok: true, lots: created };

  } finally { lock.releaseLock(); }
}

/**
 * 冷蔵庫画面の「まとめて記録」。ここがアプリの中心。
 *
 * 作り置きのとき、材料の消費は種別「作り置きへ振替」になり、食費に計上されない。
 * 代わりに合計金額を持つ新しいロットが生まれ、食べた日に計上される（仕様書6-3）。
 */
function apiRecord_(p) {
  const entries = (p.entries || []).filter(function (e) { return num_(e.qty) > 0; });
  if (!entries.length) return { ok: false, error: '記録するものがありません' };

  const makePrep = !!p.makePrep;
  const prepName = String(p.prepName || '').trim();
  if (makePrep && !prepName) return { ok: false, error: '作り置きの品名が空です' };

  const meal = MEALS.indexOf(String(p.meal)) >= 0 ? String(p.meal) : '';
  const dt   = p.datetime ? String(p.datetime) : nowStr_();
  const date = dt.slice(0, 10);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const shLots = sheet_('lots');
    const shCons = sheet_('cons');
    const byId = {};
    readAll_('lots').forEach(function (l) { byId[String(l['ロットID'])] = l; });

    const consRows = [], consIds = [], touched = [];
    let prepCost = 0;

    entries.forEach(function (en) {
      const lot = byId[String(en.lotId)];
      if (!lot) throw new Error('ロットが見つかりません: ' + en.lotId);

      const remain = num_(lot['残量']);
      let qty = Math.min(num_(en.qty), remain);
      qty = Math.round(qty * 1000) / 1000;
      if (!(qty > 0)) return;

      const perU = num_(lot['円/単位']);
      const yen  = Math.round(qty * perU * 100) / 100;

      let kind = String(en.kind || KIND.use);
      if (makePrep && kind === KIND.use) kind = KIND.prep;
      if (kind === KIND.prep) prepCost += yen;

      const id = newId_('C');
      consIds.push(id);
      consRows.push(rowFor_('cons', {
        '消費ID': id, '日時': dt, '日付': date,
        'ロットID': String(lot['ロットID']), '食材ID': String(lot['食材ID']), '品名': String(lot['品名']),
        '単位': String(lot['単位'] || 'g'), '使用量': qty, '金額': yen,
        '食事区分': (kind === KIND.use ? meal : ''),   // 廃棄・振替に食事区分は付けない
        '種別': kind, '振替先ロットID': '', '作成日時': nowStr_(),
      }));

      const newRemain = Math.round((remain - qty) * 1000) / 1000;
      const status = newRemain <= 0.0005 ? '使い切り' : '在庫あり';
      shLots.getRange(lot._row, col_('lots', '残量'), 1, 2).setValues([[Math.max(0, newRemain), status]]);
      lot['残量'] = Math.max(0, newRemain);
      lot['状態'] = status;
      touched.push(lotOut_(lot));
    });

    if (!consRows.length) return { ok: false, error: '記録するものがありません' };

    // 作り置きロットを1件生成する。新しい仕組みは足さず、既存のロットの形をそのまま使う
    let prepLot = null;
    if (makePrep) {
      const foodId = ensurePrepFood_(prepName);
      const lotId = newId_('L');
      const cost = Math.round(prepCost * 100) / 100;
      ensureRoom_(shLots, shLots.getLastRow() + 1, HEADERS.lots.length);
      shLots.appendRow(rowFor_('lots', {
        'ロットID': lotId, '日付': date, '食材ID': foodId, '品名': prepName,
        '単位': PREP_UNIT_LABEL, '内容量': PREP_UNIT, '金額': cost, '円/単位': cost / PREP_UNIT,
        '残量': PREP_UNIT, '状態': '在庫あり', '由来': '作り置き', '作成日時': nowStr_(),
      }));
      prepLot = {
        id: lotId, date: date, foodId: foodId, name: prepName, unit: PREP_UNIT_LABEL,
        qty: PREP_UNIT, yen: cost, perU: cost / PREP_UNIT,
        remain: PREP_UNIT, status: '在庫あり', source: '作り置き',
      };
      const ki = idx_('cons', '種別'), ti = idx_('cons', '振替先ロットID');
      consRows.forEach(function (r) { if (r[ki] === KIND.prep) r[ti] = lotId; });
    }

    const catCons = shCons.getLastRow() + 1;
    ensureRoom_(shCons, catCons + consRows.length - 1, HEADERS.cons.length);
    shCons.getRange(catCons, 1, consRows.length, HEADERS.cons.length).setValues(consRows);

    return {
      ok: true, consIds: consIds, lots: touched, prepLot: prepLot,
      summary: buildSummary_(date.slice(0, 7)),
      day: buildDay_(today_()),
    };

  } finally { lock.releaseLock(); }
}

/**
 * 在庫管理しないが食費には含める支出（外食・飲料・調味料・米など）。
 * 食事区分は区分によらず指定できる。
 * 「朝食のつもりで飲んだパックジュース」を朝に入れられるようにするため。
 */
function apiAddExpense_(p) {
  const yen = num_(p.yen);
  if (!(yen > 0)) return { ok: false, error: '金額が0です' };

  const kinds = getListConf_('outKinds', DEFAULT_OUT_KINDS);
  const kind = kinds.indexOf(String(p.kind)) >= 0 ? String(p.kind) : 'その他';
  const date = p.date ? d2s_(p.date) : today_();
  const meal = MEALS.indexOf(String(p.meal)) >= 0 ? String(p.meal) : '';
  const id = newId_('O');

  const shO = sheet_('out');
  ensureRoom_(shO, shO.getLastRow() + 1, HEADERS.out.length);
  shO.appendRow(rowFor_('out', {
    '支出ID': id, '日付': date, '区分': kind, '店名・品名': String(p.name || ''),
    '金額': yen, '食事区分': meal, '由来': String(p.source || '手入力'), '作成日時': nowStr_(),
  }));

  return {
    ok: true,
    expense: { id: id, date: date, kind: kind, name: String(p.name || ''), yen: yen, meal: meal },
    summary: buildSummary_(date.slice(0, 7)),
    day: buildDay_(today_()),
  };
}

/** 直前の記録を取り消す。残量も戻す。 */
function apiUndo_(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const restored = {};

    if (p.consIds && p.consIds.length) {
      const shCons = sheet_('cons');
      const target = {};
      p.consIds.forEach(function (id) { target[String(id)] = true; });
      const hits = readAll_('cons').filter(function (c) { return target[String(c['消費ID'])]; });
      hits.forEach(function (c) {
        const lotId = String(c['ロットID']);
        restored[lotId] = (restored[lotId] || 0) + num_(c['使用量']);
      });
      hits.map(function (c) { return c._row; })
          .sort(function (a, b) { return b - a; })
          .forEach(function (r) { shCons.deleteRow(r); });
    }

    if (p.prepLotId) {
      const sh = sheet_('lots');
      const r = findRow_(sh, col_('lots', 'ロットID'), String(p.prepLotId));
      if (r > 0) sh.deleteRow(r);
    }
    if (p.lotIds && p.lotIds.length) {
      const sh = sheet_('lots');
      p.lotIds.map(function (id) { return findRow_(sh, col_('lots', 'ロットID'), String(id)); })
              .filter(function (r) { return r > 0; })
              .sort(function (a, b) { return b - a; })
              .forEach(function (r) { sh.deleteRow(r); });
    }
    if (p.expenseIds && p.expenseIds.length) {
      const sh = sheet_('out');
      p.expenseIds.map(function (id) { return findRow_(sh, col_('out', '支出ID'), String(id)); })
                  .filter(function (r) { return r > 0; })
                  .sort(function (a, b) { return b - a; })
                  .forEach(function (r) { sh.deleteRow(r); });
    }

    const shLots = sheet_('lots');
    const touched = [];
    readAll_('lots').forEach(function (l) {
      const back = restored[String(l['ロットID'])];
      if (!back) return;
      const cap = num_(l['内容量']);
      const val = Math.min(cap, Math.round((num_(l['残量']) + back) * 1000) / 1000);
      shLots.getRange(l._row, col_('lots', '残量'), 1, 2)
            .setValues([[val, val > 0 ? '在庫あり' : '使い切り']]);
      l['残量'] = val;
      l['状態'] = val > 0 ? '在庫あり' : '使い切り';
      touched.push(lotOut_(l));
    });

    return { ok: true, lots: touched, summary: buildSummary_(today_().slice(0, 7)), day: buildDay_(today_()) };

  } finally { lock.releaseLock(); }
}

function apiSetConf_(key, list) {
  const clean = (list || []).map(function (s) { return String(s).trim(); })
                            .filter(function (s) { return s; });
  if (!clean.length) return { ok: false, error: '空にはできません' };
  setConf_(key, clean.join(','));
  const out = { ok: true };
  out[key] = clean;
  return out;
}


/* =============================================================================
 * 集計
 * ===========================================================================*/

/**
 *   その日の食費 = その日の消費金額（種別=消費）の合計 + その日の在庫外支出の合計
 *
 * ・種別「作り置きへ振替」は計上しない（食べた日に計上されるため。二重計上の防止）
 * ・種別「廃棄」も食費には含めず、別枠で出す（食べていないため）
 *
 * byDate は「日付 + 食事区分」の粒度。同じファイルのあすけん栄養データと
 * 突き合わせれば 円/kcal が出せる（仕様書7-3）。
 */
function buildSummary_(ym) {
  const inMonth = function (d) { return d2s_(d).slice(0, 7) === ym; };

  const byMeal = { '朝': 0, '昼': 0, '夕': 0, '間食': 0, '': 0 };
  const byDate = {};
  let consTotal = 0, wasteTotal = 0, prepTotal = 0;

  const bump = function (date, meal, yen) {
    if (!byDate[date]) byDate[date] = { total: 0, meals: { '朝': 0, '昼': 0, '夕': 0, '間食': 0, '': 0 } };
    byDate[date].total += yen;
    byDate[date].meals[meal in byDate[date].meals ? meal : ''] += yen;
  };

  readAll_('cons').forEach(function (c) {
    const d = d2s_(c['日付'] || String(c['日時']).slice(0, 10));
    if (!inMonth(d)) return;
    const yen = num_(c['金額']);
    const kind = String(c['種別']);
    if (kind === KIND.waste) { wasteTotal += yen; return; }
    if (kind === KIND.prep)  { prepTotal  += yen; return; }
    const meal = String(c['食事区分'] || '');
    consTotal += yen;
    byMeal[meal in byMeal ? meal : ''] += yen;
    bump(d, meal, yen);
  });

  let outTotal = 0, eatOutTotal = 0;
  readAll_('out').forEach(function (o) {
    const d = d2s_(o['日付']);
    if (!inMonth(d)) return;
    const yen = num_(o['金額']);
    const meal = String(o['食事区分'] || '');
    outTotal += yen;
    if (String(o['区分']) === '外食') eatOutTotal += yen;
    byMeal[meal in byMeal ? meal : ''] += yen;
    bump(d, meal, yen);
  });

  const total = consTotal + outTotal;
  const days = daysElapsed_(ym);

  let stockValue = 0;
  readAll_('lots').forEach(function (l) {
    if (String(l['状態']) !== '在庫あり') return;
    stockValue += num_(l['残量']) * num_(l['円/単位']);
  });

  return {
    ym: ym,
    total: r2_(total),
    days: days,
    perDay: r2_(days ? total / days : 0),
    byMeal: {
      '朝': r2_(byMeal['朝']), '昼': r2_(byMeal['昼']),
      '夕': r2_(byMeal['夕']), '間食': r2_(byMeal['間食']),
      '未分類': r2_(byMeal['']),
    },
    mealPerDay: {
      '朝': r2_(days ? byMeal['朝'] / days : 0), '昼': r2_(days ? byMeal['昼'] / days : 0),
      '夕': r2_(days ? byMeal['夕'] / days : 0), '間食': r2_(days ? byMeal['間食'] / days : 0),
    },
    homeCook: r2_(total - eatOutTotal),
    eatOut: r2_(eatOutTotal),
    eatOutRatio: total ? Math.round(eatOutTotal / total * 1000) / 10 : 0,
    waste: r2_(wasteTotal),
    prepTransferred: r2_(prepTotal),
    stockValue: r2_(stockValue),
    byDate: byDate,
  };
}

/**
 * その日に何を食べて、いくらだったかの明細。
 * 「登録できたのか分からない」を無くすために、記録した結果をそのまま並べて返す。
 * 廃棄と作り置きへの振替も、食費には入れないが一覧には出す（記録された事実は見せる）。
 */
function buildDay_(date) {
  const d0 = d2s_(date);
  const items = [];
  const meals = { '朝': 0, '昼': 0, '夕': 0, '間食': 0, '': 0 };
  let total = 0;

  readAll_('cons').forEach(function (c) {
    if (d2s_(c['日付'] || String(c['日時']).slice(0, 10)) !== d0) return;
    const kind = String(c['種別']);
    const yen = num_(c['金額']);
    const counted = (kind !== KIND.waste && kind !== KIND.prep);
    const meal = String(c['食事区分'] || '');
    if (counted) { total += yen; meals[meal in meals ? meal : ''] += yen; }
    items.push({
      time: String(c['日時']).slice(11, 16),
      name: String(c['品名']),
      qty: num_(c['使用量']),
      unit: String(c['単位'] || ''),
      yen: r2_(yen),
      meal: meal,
      kind: kind,
      counted: counted,
      from: '在庫',
      id: String(c['消費ID']),
    });
  });

  readAll_('out').forEach(function (o) {
    if (d2s_(o['日付']) !== d0) return;
    const yen = num_(o['金額']);
    const meal = String(o['食事区分'] || '');
    total += yen;
    meals[meal in meals ? meal : ''] += yen;
    items.push({
      time: String(o['作成日時']).slice(11, 16),
      name: String(o['店名・品名'] || o['区分']),
      qty: 0, unit: '',
      yen: r2_(yen),
      meal: meal,
      kind: String(o['区分']),
      counted: true,
      from: '在庫外',
      id: String(o['支出ID']),
    });
  });

  items.sort(function (a, b) { return a.time < b.time ? -1 : a.time > b.time ? 1 : 0; });

  return {
    date: d0,
    total: r2_(total),
    meals: { '朝': r2_(meals['朝']), '昼': r2_(meals['昼']), '夕': r2_(meals['夕']),
             '間食': r2_(meals['間食']), '未分類': r2_(meals['']) },
    items: items,
  };
}

/** 当月なら今日まで、過去月ならその月の日数 */
function daysElapsed_(ym) {
  const t = today_();
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  if (ym === t.slice(0, 7)) return Number(t.slice(8, 10));
  if (ym > t.slice(0, 7)) return 1;
  return new Date(y, m, 0).getDate();
}


/* =============================================================================
 * レシート読取（仕様書 7-1 / 7-2）
 *
 * 写真は保存しない。受け取った画像をそのまま読取に渡し、
 * 品名・金額・日付だけを受け取って、画像は捨てる。ドライブにも残らない。
 * APIキーはスクリプトプロパティに置く。シートにもURLにもリポジトリにも出ない。
 * ===========================================================================*/

const OCR_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const OCR_MODEL = 'gemini-3.6-flash';
const OCR_KEY_PROP = 'OCR_API_KEY';

/** レシートから取り出したいものの形。ここを足せば取れる項目が増える */
const OCR_SCHEMA = {
  type: 'object',
  properties: {
    date:  { type: 'string', description: '購入日。yyyy-MM-dd。読み取れなければ空文字' },
    store: { type: 'string', description: '店名。読み取れなければ空文字' },
    items: {
      type: 'array',
      description: '買った品物の行だけ',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'レシートに印字された品名のまま' },
          yen:  { type: 'number', description: '税込の支払額。値引が紐づく行は引いたあとの額' },
          qty:  { type: 'number', description: '品名から内容量が分かるときだけ。「牛乳1000ml」なら1000。不明なら0' },
          unit: { type: 'string', description: 'qtyの単位。g / ml / 個 / 本 / 枚 のいずれか。不明なら空文字' },
        },
        required: ['name', 'yen'],
      },
    },
  },
  required: ['date', 'items'],
};

const OCR_PROMPT = [
  '日本のスーパーやコンビニのレシートの写真です。買った品物の行だけを取り出してください。',
  '',
  '守ってほしいこと:',
  '- 小計・合計・お預り・お釣り・現金・クレジット・電子マネー・税・ポイント・レジ番号・',
  '  責任者・電話番号・住所・買上点数は品物ではないので出さない。',
  '- 「値引」「割引」「○○引」が直前の品物にかかっている場合は、引いたあとの金額を',
  '  その品物の金額として出す。値引の行そのものは出さない。',
  '- 数量2などでまとまっている行は、その行の合計額を出す（1個あたりに割らない）。',
  '- 金額は税込を優先する。税抜しか印字されていなければ税抜のままでよい。',
  '- 品名はレシートに印字されたとおりに写す。省略形も記号もそのまま。読めない文字は推測しない。',
  '- 購入日は yyyy-MM-dd。令和などの和暦は西暦に直す。年の印字がなければ空文字にする。',
  '- 品物が1つも読み取れなければ items は空配列にする。写っていないものを作らない。',
].join('\n');

/** 品物ではない行。読み取り側が混ぜてきたときの保険 */
const OCR_DROP = /^(小計|合計|総合計|課税|非課税|税|外税|内税|消費税|お預り|預り|お釣|釣銭|釣り|現金|クレジット|カード|電子マネー|チャージ|ポイント|値引|割引|クーポン|レジ|責任者|点数|買上|お買上|領収|登録番号|№|No)/;

/**
 * 表記ゆれ列に1つ足す。足す必要がなければ null を返す。
 * 品名そのもの・すでに入っている表記・空文字は足さない。
 */
function addAlias_(current, alias, foodName) {
  const a = String(alias || '').trim();
  if (!a) return null;
  if (a === String(foodName || '').trim()) return null;

  const list = String(current || '').split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
  const key = normName_(a);
  if (list.some(function (s) { return normName_(s) === key; })) return null;

  list.push(a);
  return list.join(',');
}

/**
 * 突き合わせ用に品名をならす。全角と半角、記号、空白の違いを無視する。
 * 画面側の normalizeFoodName() と同じ規則にしてある。
 */
function normName_(s) {
  return String(s || '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xfee0); })
    .replace(/[\s　]/g, '')
    .replace(/[()（）\[\]【】"'`,.・･:：;；\/／\-ー－_]/g, '')
    .toLowerCase();
}

function ocrKey_() { return PropertiesService.getScriptProperties().getProperty(OCR_KEY_PROP) || ''; }

/** キーそのものは絶対に返さない。あるかないかだけ */
function apiOcrStatus_() {
  return { ok: true, hasKey: !!ocrKey_(), model: OCR_MODEL };
}

function apiSetOcrKey_(p) {
  const key = String(p && p.key == null ? '' : p.key).trim();
  const props = PropertiesService.getScriptProperties();
  if (!key) { props.deleteProperty(OCR_KEY_PROP); return { ok: true, hasKey: false }; }
  if (key.length < 20) return { ok: false, error: 'キーが短すぎます。貼り間違いかもしれません' };
  props.setProperty(OCR_KEY_PROP, key);
  return { ok: true, hasKey: true };
}

function apiReadReceipt_(p) {
  const key = ocrKey_();
  if (!key) return { ok: false, error: 'レシート読取のキーが未設定です。設定から貼ってください', needKey: true };

  const image = String((p && p.image) || '').replace(/^data:[^,]*,/, '');
  if (!image) return { ok: false, error: '画像がありません' };
  // インライン画像は合計20MBまで。余裕を見て切る
  if (image.length > 18 * 1024 * 1024) return { ok: false, error: '画像が大きすぎます。もう少し小さくして送ってください' };

  const body = {
    model: OCR_MODEL,
    input: [
      { type: 'text', text: OCR_PROMPT },
      { type: 'image', data: image, mime_type: String((p && p.mime) || 'image/jpeg') },
    ],
    response_format: { type: 'text', mime_type: 'application/json', schema: OCR_SCHEMA },
  };

  const res = UrlFetchApp.fetch(OCR_ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code !== 200) return { ok: false, error: ocrHttpError_(code, text), httpCode: code };

  let raw;
  try { raw = JSON.parse(text); } catch (e) { return { ok: false, error: '読み取り結果を解釈できませんでした' }; }

  const jsonText = pickOcrText_(raw);
  if (!jsonText) {
    return {
      ok: false,
      error: '読み取り結果が空でした',
      shape: Object.keys(raw || {}).join(','),
      status: String((raw && raw.status) || ''),
      sample: text.slice(0, 1200),   // 何が返ってきたのか後から追えるように
    };
  }

  let out;
  try { out = JSON.parse(jsonText); }
  catch (e) { return { ok: false, error: 'レシートの内容を読み取れませんでした。写真を撮り直すと通ることがあります' }; }

  return { ok: true, receipt: cleanReceipt_(out) };
}

/**
 * 応答のどこに本文が入っていても拾えるようにする。
 * 入れ物の名前（output / steps / candidates …）は変わりうるので、
 * 名前で探さず「JSONとして読めて、欲しい形をしている文字列」を探す。
 */
function pickOcrText_(raw) {
  if (!raw) return '';
  if (typeof raw.output_text === 'string' && looksLikeReceipt_(raw.output_text)) return raw.output_text;

  const strings = [];
  (function walk(v, d) {
    if (v == null || d > 12) return;
    if (typeof v === 'string') { if (v.indexOf('{') >= 0) strings.push(v); return; }
    if (Array.isArray(v)) { v.forEach(function (x) { walk(x, d + 1); }); return; }
    if (typeof v === 'object') { Object.keys(v).forEach(function (k) { walk(v[k], d + 1); }); }
  })(raw, 0);

  for (let i = 0; i < strings.length; i++) {
    if (looksLikeReceipt_(strings[i])) return strings[i];
  }
  // ```json ... ``` のように囲まれている場合
  for (let i = 0; i < strings.length; i++) {
    const m = strings[i].match(/\{[\s\S]*\}/);
    if (m && looksLikeReceipt_(m[0])) return m[0];
  }
  return '';
}

/** レシートの読み取り結果として辻褄が合う文字列か */
function looksLikeReceipt_(s) {
  if (!s || s.indexOf('{') < 0) return false;
  try {
    const o = JSON.parse(s);
    return !!(o && (Array.isArray(o.items) || typeof o.date === 'string'));
  } catch (e) { return false; }
}

/** 数値や日付の形をそろえ、品物でない行を落とす */
function cleanReceipt_(o) {
  const date = d2s_(String((o && o.date) || ''));
  const items = ((o && o.items) || []).map(function (it) {
    const qty = num_(it && it.qty);
    return {
      name: String((it && it.name) || '').trim(),
      yen:  num_(it && it.yen),
      qty:  qty > 0 ? qty : 0,
      unit: String((it && it.unit) || '').trim(),
    };
  }).filter(function (it) {
    if (!it.name) return false;
    if (!(it.yen > 0)) return false;
    return !OCR_DROP.test(it.name.replace(/[\s　]/g, ''));
  });

  return {
    date:  /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
    store: String((o && o.store) || '').trim(),
    items: items,
  };
}

function ocrHttpError_(code, text) {
  let msg = '';
  try { const j = JSON.parse(text); msg = (j && j.error && (j.error.message || j.error.status)) || ''; } catch (e) {}
  if (code === 400 && /api[ _-]?key/i.test(msg)) return 'キーが正しくないようです。設定から貼り直してください';
  if (code === 401 || code === 403) return 'キーが使えませんでした。設定から貼り直してください';
  if (code === 429) return '読み取りの回数制限に当たりました。少し待ってからもう一度';
  if (code >= 500) return '読み取り側が一時的に応答しませんでした。もう一度試してください';
  return '読み取りに失敗しました（' + code + '）' + (msg ? ': ' + msg.slice(0, 120) : '');
}


/* =============================================================================
 * 小物
 * ===========================================================================*/

function ss_() { return SpreadsheetApp.openById(SS_ID); }

/** 列名 -> 0始まりの位置 */
function idx_(key, header) {
  const i = HEADERS[key].indexOf(header);
  if (i < 0) throw new Error('列がありません: ' + key + '.' + header);
  return i;
}
/** 列名 -> 1始まりの列番号（getRange用） */
function col_(key, header) { return idx_(key, header) + 1; }

/** 列名をキーにしたオブジェクトから、シートの並びどおりの配列を作る */
function rowFor_(key, obj) {
  return HEADERS[key].map(function (h) { return obj[h] !== undefined ? obj[h] : ''; });
}

/**
 * 1マスだけ書式と値を入れる。
 * シートが Google の「テーブル」になっていると、2列以上にまたがる書式指定が
 * 「列単位の操作を行うには、1つの列内で1つだけ選択してください。」で弾かれる。
 * 列をまたがない形に分けておけば、テーブルでも普通のシートでも通る。
 */
function setCell_(sh, row, col, value, format) {
  const r = sh.getRange(row, col);
  if (format) r.setNumberFormat(format);
  r.setValue(value);
}

/**
 * シートの枠（行数・列数）が足りているか確かめて、足りなければ広げる。
 * 枠の外に setValues しようとすると Sheets が
 * 「列単位の操作を行うには、1つの列内で1つだけ選択してください。」という
 * 分かりにくい例外を投げるので、書き込む前に必ず通す。
 */
function ensureRoom_(sh, lastRow, lastCol) {
  const mr = sh.getMaxRows();
  if (mr < lastRow) sh.insertRowsAfter(mr, lastRow - mr);
  const mc = sh.getMaxColumns();
  if (mc < lastCol) sh.insertColumnsAfter(mc, lastCol - mc);
}

/** 列ごとの表示形式を明示する。何度呼んでも安全 */
function applyFormats_(sh, headers) {
  const rows = Math.max(1, sh.getMaxRows() - 1);
  headers.forEach(function (h, i) {
    if (TEXT_HEADERS.indexOf(h) >= 0) {
      sh.getRange(2, i + 1, rows, 1).setNumberFormat('@');
    } else if (NUMBER_HEADERS.indexOf(h) >= 0) {
      sh.getRange(2, i + 1, rows, 1).setNumberFormat('0.############');
    }
  });
}

function sheet_(key) {
  const name = SHEETS[key];
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    const h = HEADERS[key];
    sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold').setBackground('#f1f3f4');
    sh.setFrozenRows(1);
    applyFormats_(sh, h);
    if (sh.getMaxColumns() > h.length) sh.deleteColumns(h.length + 1, sh.getMaxColumns() - h.length);
    sh.autoResizeColumns(1, h.length);
  }
  return sh;
}

function readAll_(key) {
  const sh = sheet_(key);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const h = HEADERS[key];
  const vals = sh.getRange(2, 1, last - 1, h.length).getValues();
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).trim() === '') continue;
    const o = { _row: i + 2 };
    for (let c = 0; c < h.length; c++) o[h[c]] = vals[i][c];
    out.push(o);
  }
  return out;
}

function findRow_(sh, colNo, value) {
  const last = sh.getLastRow();
  if (last < 2) return -1;
  const vals = sh.getRange(2, colNo, last - 1, 1).getValues();
  for (let i = 0; i < vals.length; i++) if (String(vals[i][0]) === String(value)) return i + 2;
  return -1;
}

function lotOut_(l) {
  return {
    id: String(l['ロットID']),
    date: d2s_(l['日付']),
    foodId: String(l['食材ID']),
    name: String(l['品名']),
    unit: String(l['単位'] || 'g'),
    qty: num_(l['内容量']),
    yen: num_(l['金額']),
    perU: num_(l['円/単位']),
    remain: num_(l['残量']),
    status: String(l['状態']),
    source: String(l['由来'] || ''),
  };
}

function foodOut_(f) {
  return {
    id: String(f['食材ID']),
    name: String(f['品名']),
    aliases: String(f['表記ゆれ'] || ''),
    category: String(f['置き場カテゴリ'] || ''),
    unit: String(f['単位'] || 'g'),
    tracked: truthy_(f['在庫管理する']),
    lastQty: num_(f['前回の量']),
    lastYen: num_(f['前回の円']),
    lastBuy: '',
  };
}

function ensurePrepFood_(name) {
  const hit = readAll_('foods').filter(function (f) {
    return String(f['品名']) === name && String(f['置き場カテゴリ']) === '作り置き';
  })[0];
  if (hit) return String(hit['食材ID']);

  const id = newId_('F');
  const shPf = sheet_('foods');
  ensureRoom_(shPf, shPf.getLastRow() + 1, HEADERS.foods.length);
  shPf.appendRow(rowFor_('foods', {
    '食材ID': id, '品名': name, '表記ゆれ': '', '置き場カテゴリ': '作り置き',
    '単位': PREP_UNIT_LABEL, '在庫管理する': true,
    '前回の量': PREP_UNIT, '前回の円': '', '更新日時': nowStr_(),
  }));
  return id;
}

function getListConf_(key, fallback) {
  const raw = getConf_(key);
  if (!raw) return fallback.slice();
  const list = String(raw).split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
  return list.length ? list : fallback.slice();
}

function getConf_(key) {
  const hit = readAll_('conf').filter(function (r) { return String(r['キー']) === key; })[0];
  return hit ? hit['値'] : null;
}

function setConf_(key, value) {
  const sh = sheet_('conf');
  const r = findRow_(sh, 1, key);
  if (r > 0) sh.getRange(r, 2).setValue(value);
  else { ensureRoom_(sh, sh.getLastRow() + 1, HEADERS.conf.length); sh.appendRow([key, value]); }
}

function newId_(prefix) {
  return prefix + Date.now().toString(36) + Math.floor(Math.random() * 1679616).toString(36);
}

function today_()  { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function nowStr_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }

function d2s_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  const s = String(v || '').trim();
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  return s;
}

function num_(v) {
  if (v === '' || v == null) return 0;
  // 表示形式のせいで数値が日付として読まれた場合、シリアル値に戻す
  // （1899-12-30 を 0 とする Google スプレッドシートの基準）
  if (v instanceof Date) {
    return Math.round((v.getTime() - Date.UTC(1899, 11, 30)) / 86400000 * 1000000) / 1000000;
  }
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function truthy_(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'はい' || s === '○';
}

function r2_(n) { return Math.round(n * 100) / 100; }
