/* 本物の Code.gs を Node で動かして、記録まわりの計算が仕様どおりかを確かめる。
   使い方: node test/run.js */
const { makeSandbox } = require('./gasmock');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const near = (a, b, eps) => Math.abs(Number(a) - Number(b)) < (eps === undefined ? 0.01 : eps);
const section = (s) => console.log('\n' + s);

function newEnv(now) {
  const env = makeSandbox({ now: now || '2026-09-05T03:00:00Z' });
  env.sandbox.setup();
  const tk = env.props.APP_TOKEN;
  env.call = (action, payload) => env.sandbox.handle_({ action, token: tk, payload: payload || {} });
  env.rows = (name) => {
    const sh = env.ss.getSheetByName(name);
    const last = sh.getLastRow();
    if (last < 2) return [];
    const h = sh.getRange(1, 1, 1, sh.getMaxColumns()).getValues()[0].filter((x) => x !== '');
    return sh.getRange(2, 1, last - 1, h.length).getValues()
      .map((r) => { const o = {}; h.forEach((k, i) => (o[k] = r[i])); return o; });
  };
  return env;
}

/* ------------------------------------------------------------------ */
section('セットアップと基本の記録');
{
  const e = newEnv();
  ok('シートが揃う',
     ['食材マスタ', '仕入', '消費', '在庫外支出', '設定']
       .every((n) => !!e.ss.getSheetByName(n)),
     e.ss.getSheets().map((s) => s.getName()));
  ok('トークンが発行される', !!e.props.APP_TOKEN);
  ok('トークンが違えば断る', e.sandbox.handle_({ action: 'bootstrap', token: 'nope', payload: {} }).authFailed === true);

  const f = e.call('addFood', { name: '豚こま肉', category: 'チルド', unit: 'g', tracked: true });
  ok('食材を作れる', f.ok && f.food.name === '豚こま肉');
  const l = e.call('addLots', { items: [{ foodId: f.food.id, qty: 500, yen: 1000, unit: 'g', date: '2026-09-05' }] });
  ok('仕入が入る', l.ok === true, l.error);
  ok('円/単位が出る', near(l.lots[0].perU, 2));

  const r = e.call('record', { meal: '昼', datetime: '2026-09-05 12:00:00',
                               entries: [{ lotId: l.lots[0].id, qty: 100 }] });
  ok('消費できる', r.ok === true, r.error);
  ok('残量が減る', near(e.call('bootstrap', {}).lots[0].remain, 400));
  ok('食費に乗る', near(e.call('summary', { ym: '2026-09' }).summary.total, 200));
}

/* ------------------------------------------------------------------ */
section('明細から1件消す');
{
  const e = newEnv();
  const f = e.call('addFood', { name: '豚こま肉', category: 'チルド', unit: 'g', tracked: true });
  const lot = e.call('addLots', { items: [{ foodId: f.food.id, qty: 500, yen: 1000, unit: 'g', date: '2026-09-05' }] }).lots[0];
  const rec = e.call('record', { meal: '昼', datetime: '2026-09-05 12:00:00',
                                 entries: [{ lotId: lot.id, qty: 100 }] });
  const cid = rec.consIds[0];

  ok('消す前は食費に入っている', near(e.call('summary', { ym: '2026-09' }).summary.total, 200));

  const del = e.call('deleteRecord', { id: cid });
  ok('消せる', del.ok === true, del.error);
  ok('何を消したかを返す', del.removed && del.removed.name === '豚こま肉', del.removed);
  ok('消費の行が無くなる', e.rows('消費').length === 0, e.rows('消費').length);
  ok('残量が戻る', near(e.call('bootstrap', {}).lots[0].remain, 500));
  ok('状態も在庫ありに戻る', e.call('bootstrap', {}).lots[0].status === '在庫あり');
  ok('食費から引かれる', near(e.call('summary', { ym: '2026-09' }).summary.total, 0));
  ok('仕入の行は消えない', e.rows('仕入').length === 1);

  ok('無いIDは消せない', e.call('deleteRecord', { id: 'Cnope' }).ok === false);
  ok('IDが空なら断る', e.call('deleteRecord', {}).ok === false);

  // 使い切ったあとに消しても、ちゃんと在庫ありに戻る
  const r2 = e.call('record', { meal: '夕', datetime: '2026-09-05 19:00:00',
                                entries: [{ lotId: lot.id, qty: 500 }] });
  ok('使い切れる', e.call('bootstrap', {}).lots.length === 0);
  const d2 = e.call('deleteRecord', { id: r2.consIds[0] });
  ok('使い切りからも戻せる', d2.ok && near(e.call('bootstrap', {}).lots[0].remain, 500), d2.error);
}

/* ------------------------------------------------------------------ */
section('在庫外支出も消せる');
{
  const e = newEnv();
  const x = e.call('addExpense', { kind: '外食', name: 'ラーメン', yen: 900, meal: '昼', date: '2026-09-05' });
  ok('支出を入れられる', x.ok === true, x.error);
  ok('食費に乗る', near(e.call('summary', { ym: '2026-09' }).summary.total, 900));
  const del = e.call('deleteRecord', { id: x.expense.id });
  ok('消せる', del.ok === true, del.error);
  ok('行が無くなる', e.rows('在庫外支出').length === 0);
  ok('食費から引かれる', near(e.call('summary', { ym: '2026-09' }).summary.total, 0));
}

/* ------------------------------------------------------------------ */
section('作り置きへの振替を消す');
{
  // 材料がそれ1つだけ → 作り置きごと消える
  const e = newEnv();
  const f = e.call('addFood', { name: '鶏もも肉', category: 'チルド', unit: 'g', tracked: true });
  const lot = e.call('addLots', { items: [{ foodId: f.food.id, qty: 600, yen: 900, unit: 'g', date: '2026-09-05' }] }).lots[0];
  const mk = e.call('record', { meal: '昼', datetime: '2026-09-05 12:00:00',
                                makePrep: true, prepName: '鶏ハム', prepServings: 3,
                                entries: [{ lotId: lot.id, qty: 300 }] });
  ok('作り置きができる', mk.ok && mk.prepLot.unit === '食', mk.error);
  ok('作った日は食費に入らない', near(e.call('summary', { ym: '2026-09' }).summary.total, 0));

  const del = e.call('deleteRecord', { id: mk.consIds[0] });
  ok('振替を消せる', del.ok === true, del.error);
  ok('材料が戻る', near(e.call('bootstrap', {}).lots.filter((l) => l.name === '鶏もも肉')[0].remain, 600));
  ok('作り置きも消える', e.rows('仕入').filter((l) => String(l['品名']) === '鶏ハム').length === 0);
  ok('消した作り置きの名前を返す', del.removed && del.removed.prepDeleted === '鶏ハム', del.removed);
}
{
  // 材料が他にもある → その材料ぶんだけ作り置きの金額が減る
  const e = newEnv();
  const a = e.call('addFood', { name: '鶏もも肉', category: 'チルド', unit: 'g', tracked: true });
  const b = e.call('addFood', { name: '玉ねぎ', category: '野菜室', unit: 'g', tracked: true });
  const la = e.call('addLots', { items: [{ foodId: a.food.id, qty: 600, yen: 900, unit: 'g', date: '2026-09-05' }] }).lots[0];
  const lb = e.call('addLots', { items: [{ foodId: b.food.id, qty: 300, yen: 150, unit: 'g', date: '2026-09-05' }] }).lots[0];
  const mk = e.call('record', { meal: '夕', datetime: '2026-09-05 19:00:00',
                                makePrep: true, prepName: 'スープ', prepServings: 4,
                                entries: [{ lotId: la.id, qty: 300 }, { lotId: lb.id, qty: 100 }] });
  ok('2種類から作り置きができる', mk.ok === true, mk.error);
  ok('材料の合計が作り置きの金額', near(mk.prepLot.yen, 450 + 50), mk.prepLot.yen);

  const cons = e.rows('消費');
  const onion = cons.filter((c) => String(c['品名']) === '玉ねぎ')[0];
  const del = e.call('deleteRecord', { id: String(onion['消費ID']) });
  ok('片方だけ消せる', del.ok === true, del.error);
  ok('玉ねぎが戻る', near(e.call('bootstrap', {}).lots.filter((l) => l.name === '玉ねぎ')[0].remain, 300));
  const prep = e.rows('仕入').filter((l) => String(l['品名']) === 'スープ')[0];
  ok('作り置きは残る', !!prep);
  ok('その材料ぶんだけ金額が減る', prep && near(Number(prep['金額']), 450), prep && prep['金額']);
  ok('1食あたりも引き直される', prep && near(Number(prep['円/単位']), 450 / 4), prep && prep['円/単位']);
  ok('鶏もも肉は戻らない', near(e.call('bootstrap', {}).lots.filter((l) => l.name === '鶏もも肉')[0].remain, 300));
}
{
  // もう食べている作り置きの材料は消せない
  const e = newEnv();
  const f = e.call('addFood', { name: '鶏もも肉', category: 'チルド', unit: 'g', tracked: true });
  const lot = e.call('addLots', { items: [{ foodId: f.food.id, qty: 600, yen: 900, unit: 'g', date: '2026-09-05' }] }).lots[0];
  const mk = e.call('record', { meal: '昼', datetime: '2026-09-05 12:00:00',
                                makePrep: true, prepName: '鶏ハム', prepServings: 3,
                                entries: [{ lotId: lot.id, qty: 300 }] });
  e.call('record', { meal: '夕', datetime: '2026-09-05 19:00:00',
                     entries: [{ lotId: mk.prepLot.id, qty: 1 }] });

  const del = e.call('deleteRecord', { id: mk.consIds[0] });
  ok('食べた記録があるときは断る', del.ok === false, del);
  ok('どうすればいいかを伝える', del.error && del.error.indexOf('鶏ハム') >= 0, del.error);
  ok('断ったときは何も消えていない', e.rows('仕入').filter((l) => String(l['品名']) === '鶏ハム').length === 1);
  ok('材料も戻していない', near(e.call('bootstrap', {}).lots.filter((l) => l.name === '鶏もも肉')[0].remain, 300));

  // 先に作り置きのほうを消せば、振替も消せるようになる
  const eaten = e.rows('消費').filter((c) => String(c['種別']) === '消費')[0];
  ok('作り置きを食べた記録は消せる', e.call('deleteRecord', { id: String(eaten['消費ID']) }).ok === true);
  ok('そのあとなら振替も消せる', e.call('deleteRecord', { id: mk.consIds[0] }).ok === true);
  ok('材料が全部戻る', near(e.call('bootstrap', {}).lots.filter((l) => l.name === '鶏もも肉')[0].remain, 600));
}

/* ------------------------------------------------------------------ */
section('廃棄・調整の記録も消せる');
{
  const e = newEnv();
  const f = e.call('addFood', { name: 'にんじん', category: '野菜室', unit: 'g', tracked: true });
  const lot = e.call('addLots', { items: [{ foodId: f.food.id, qty: 300, yen: 180, unit: 'g', date: '2026-09-05' }] }).lots[0];
  const w = e.call('record', { meal: '夕', datetime: '2026-09-05 19:00:00',
                               entries: [{ lotId: lot.id, qty: 50, kind: '廃棄' }] });
  ok('廃棄できる', w.ok === true, w.error);
  ok('廃棄は食費に入らない', near(e.call('summary', { ym: '2026-09' }).summary.total, 0));
  ok('廃棄として集計される', near(e.call('summary', { ym: '2026-09' }).summary.waste, 30));
  const del = e.call('deleteRecord', { id: w.consIds[0] });
  ok('廃棄も消せる', del.ok === true, del.error);
  ok('残量が戻る', near(e.call('bootstrap', {}).lots[0].remain, 300));
  ok('廃棄の集計も戻る', near(e.call('summary', { ym: '2026-09' }).summary.waste, 0));
}

section('仕入の金額を後から直す（0円にできる）');
{
  const e = newEnv();
  const f = e.call('addFood', { name: 'BASEラーメン', category: '常温', unit: '個', tracked: true });
  const lot = e.call('addLots', { items: [{ foodId: f.food.id, qty: 2, yen: 784, unit: '個', date: '2025-12-10' }] }).lots[0];
  e.call('record', { meal: '昼', datetime: '2026-09-05 12:00:00', entries: [{ lotId: lot.id, qty: 1 }] });
  ok('食べると食費に乗る', near(e.call('summary', { ym: '2026-09' }).summary.total, 392));

  // もう払い終わっているので0円にする
  const z = e.call('fixLot', { lotId: lot.id, yen: 0 });
  ok('0円に直せる', z.ok === true, z.error);
  ok('金額が0になる', near(z.lot.after, 0), z.lot);
  ok('食べた分も0円に引き直される', z.cons.length === 1 && near(z.cons[0].after, 0), z.cons);
  ok('食費から消える', near(e.call('summary', { ym: '2026-09' }).summary.total, 0));
  ok('在庫の評価額も0になる', near(e.call('summary', { ym: '2026-09' }).summary.stockValue, 0));

  const b = e.call('bootstrap', {});
  const l2 = b.lots.filter((x) => x.name === 'BASEラーメン')[0];
  ok('数量は減らない', l2 && near(l2.remain, 1), l2 && l2.remain);
  ok('在庫としては残る', l2 && l2.status === '在庫あり');

  // 0円のロットを食べても食費は動かない
  const before = e.call('summary', { ym: '2026-09' }).summary.total;
  e.call('record', { meal: '夕', datetime: '2026-09-06 19:00:00', entries: [{ lotId: lot.id, qty: 1 }] });
  ok('0円の在庫は食べても食費が動かない',
     near(e.call('summary', { ym: '2026-09' }).summary.total, before));

  // 0円で最初から仕入れることもできる（完全メシ・乾物用）
  const g = e.call('addFood', { name: '完全メシ', category: '常温', unit: '個', tracked: true });
  const l3 = e.call('addLots', { items: [{ foodId: g.food.id, qty: 4, yen: 0, unit: '個', date: '2026-03-01' }] });
  ok('0円で仕入れられる', l3.ok === true, l3.error);
  ok('円/単位も0', near(l3.lots[0].perU, 0));
  e.call('record', { meal: '昼', datetime: '2026-09-07 12:00:00', entries: [{ lotId: l3.lots[0].id, qty: 1 }] });
  ok('食べても食費に乗らない', near(e.call('summary', { ym: '2026-09' }).summary.total, before));
  ok('残量はちゃんと減る',
     near(e.call('bootstrap', {}).lots.filter((x) => x.name === '完全メシ')[0].remain, 3));

  // 負の金額は断る
  ok('マイナスは断る', e.call('fixLot', { lotId: lot.id, yen: -100 }).ok === false);
  ok('ロットIDが無ければ断る', e.call('fixLot', { yen: 0 }).ok === false);

  // 打ち間違いを直す用途も従来どおり
  const h = e.call('addFood', { name: '鶏もも肉', category: 'チルド', unit: 'g', tracked: true });
  const l4 = e.call('addLots', { items: [{ foodId: h.food.id, qty: 330, yen: 3460, unit: 'g', date: '2026-09-01' }] }).lots[0];
  const fx = e.call('fixLot', { lotId: l4.id, yen: 346 });
  ok('桁の打ち間違いも直せる', fx.ok && near(fx.lot.after, 346), fx.error);
  ok('円/単位が引き直される', near(fx.lot.perU, 346 / 330));
}

/* ------------------------------------------------------------------ */
section('レシート読取：混んでいたら投げ直す');
{
  // 読み取りが成功したときに返ってくる形をまねる
  const good = JSON.stringify({
    output_text: JSON.stringify({
      date: '2026-09-28', store: 'テスト店', taxMode: '内税', total: 198,
      items: [{ name: 'キャベツ', yen: 198, taxRate: 8 }],
    }),
  });
  const busy = JSON.stringify({ error: { message: 'The model is overloaded.', status: 'UNAVAILABLE' } });

  {
    const e = newEnv();
    e.call('setOcrKey', { key: 'x'.repeat(30) });
    // 3.6 はずっと混雑。別のモデルなら空いている
    e.net.reply = (url, params) => {
      const body = JSON.parse(params.payload);
      return body.model === 'gemini-3.6-flash' ? { code: 503, body: busy } : { code: 200, body: good };
    };
    e.net.sleeps.length = 0;
    const r = e.call('readReceipt', { image: 'AAAA', mime: 'image/jpeg' });
    ok('詰まったら別のモデルに移る', r.ok === true, r.error);
    ok('移った先が返ってくる', r.model === 'gemini-3.8-flash', r.model);
    ok('一周目は待たずに回す', e.net.sleeps.length === 0, e.net.sleeps);
    ok('中身も読めている', r.receipt.items[0].name === 'キャベツ', r.receipt);
  }

  {
    const e = newEnv();
    e.call('setOcrKey', { key: 'x'.repeat(30) });
    // 一周目は全部混雑、二周目で空く
    let n = 0;
    e.net.reply = () => { n++; return n <= 3 ? { code: 503, body: busy } : { code: 200, body: good }; };
    e.net.sleeps.length = 0;
    const r = e.call('readReceipt', { image: 'AAAA', mime: 'image/jpeg' });
    ok('一周塞がっていても二周目で通る', r.ok === true, r.error);
    ok('4回目で通った', r.tries === 4, r.tries);
    ok('二周目の前だけ待つ', e.net.sleeps.length === 1, e.net.sleeps);
  }

  {
    const e = newEnv();
    e.call('setOcrKey', { key: 'x'.repeat(30) });
    e.net.reply = () => ({ code: 503, body: busy });
    e.net.fetches.length = 0;   // setup() が権限確認で1回叩いているので、ここから数える
    const r = e.call('readReceipt', { image: 'AAAA', mime: 'image/jpeg' });
    ok('どこも混んでいたら諦める', r.ok === false);
    ok('混雑だと分かる文面になる', /混/.test(r.error), r.error);
    ok('3モデルを2周で打ち止め', e.net.fetches.length === 6, e.net.fetches.length);
  }

  {
    // 429は投げすぎのサイン。投げ直すと悪化するので一度で引く
    const e = newEnv();
    e.call('setOcrKey', { key: 'x'.repeat(30) });
    e.net.reply = () => ({ code: 429, body: JSON.stringify({ error: { message: 'Too many requests' } }) });
    e.net.fetches.length = 0;
    const r = e.call('readReceipt', { image: 'AAAA', mime: 'image/jpeg' });
    ok('回数制限なら投げ直さない', e.net.fetches.length === 1, e.net.fetches.length);
    ok('間を空けるよう伝える', /空けて/.test(r.error), r.error);
  }

  {
    const e = newEnv();
    e.call('setOcrKey', { key: 'x'.repeat(30) });
    e.net.reply = () => ({ code: 400, body: JSON.stringify({ error: { message: 'API key not valid' } }) });
    e.net.fetches.length = 0;
    const r = e.call('readReceipt', { image: 'AAAA', mime: 'image/jpeg' });
    ok('キー違いは投げ直さない', e.net.fetches.length === 1, e.net.fetches.length);
    ok('キーを貼り直すよう伝える', /キー/.test(r.error), r.error);
  }
}

/* ------------------------------------------------------------------ */
section('記録は在庫だけ減って明細が消えることがない');
{
  const e = newEnv();
  const f = e.call('addFood', { name: 'にんじん', category: '野菜室', unit: '本', tracked: true });
  const g = e.call('addFood', { name: 'さくら漬け', category: '冷蔵', unit: 'g', tracked: true });
  const h = e.call('addFood', { name: '冷凍ごはん', category: '冷凍', unit: '食', tracked: true });
  const L = e.call('addLots', { items: [
    { foodId: f.food.id, qty: 3, yen: 341, unit: '本', date: '2026-09-16' },
    { foodId: g.food.id, qty: 225, yen: 106, unit: 'g', date: '2026-09-02' },
    { foodId: h.food.id, qty: 9, yen: 224, unit: '食', date: '2026-09-14' },
  ] }).lots;

  const r = e.call('record', { meal: '昼', datetime: '2026-09-18 15:30:00', entries: [
    { lotId: L[0].id, qty: 0.5 }, { lotId: L[1].id, qty: 10 }, { lotId: L[2].id, qty: 1 },
  ] });
  ok('まとめて記録できる', r.ok === true, r.error);

  // 「内容量 − 記録済みの消費 = 残量」が全部のロットで合っていること。
  // 9/18の事故は、ここがズレた（残量だけ減って明細が無かった）
  const lots = e.rows('仕入'), cons = e.rows('消費');
  const used = {};
  cons.forEach((c) => { used[String(c['ロットID'])] = (used[String(c['ロットID'])] || 0) + Number(c['使用量']); });
  const allMatch = lots.every((l) => near(Number(l['内容量']) - (used[String(l['ロットID'])] || 0), Number(l['残量'])));
  ok('残量と明細が食い違わない', allMatch,
     lots.map((l) => l['品名'] + ':' + l['残量'] + '/' + l['内容量'] + ' 使用' + (used[String(l['ロットID'])] || 0)));
  ok('3件とも明細に残る', cons.length === 3, cons.length);

  // 消してもズレない
  e.call('deleteRecord', { id: String(cons[0]['消費ID']) });
  const lots2 = e.rows('仕入'), cons2 = e.rows('消費');
  const used2 = {};
  cons2.forEach((c) => { used2[String(c['ロットID'])] = (used2[String(c['ロットID'])] || 0) + Number(c['使用量']); });
  ok('1件消してもズレない',
     lots2.every((l) => near(Number(l['内容量']) - (used2[String(l['ロットID'])] || 0), Number(l['残量']))),
     lots2.map((l) => l['品名'] + ':' + l['残量']));
}

/* ------------------------------------------------------------------ */
section('残量の書き戻しは飛び飛びの行でも壊れない');
{
  const e = newEnv();
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const f = e.call('addFood', { name: '野菜' + i, category: '野菜室', unit: '個', tracked: true });
    ids.push(e.call('addLots', { items: [{ foodId: f.food.id, qty: 10, yen: 100, unit: '個', date: '2026-09-01' }] }).lots[0].id);
  }
  // 1番目と5番目だけ食べる（間の3つは触らない）
  e.call('record', { meal: '昼', datetime: '2026-09-05 12:00:00',
                     entries: [{ lotId: ids[0], qty: 3 }, { lotId: ids[4], qty: 4 }] });
  const byId = {};
  e.call('bootstrap', {}).lots.forEach((l) => (byId[l.id] = l));
  ok('端の2つだけ減る', near(byId[ids[0]].remain, 7) && near(byId[ids[4]].remain, 6),
     [byId[ids[0]].remain, byId[ids[4]].remain]);
  ok('間の3つは元のまま',
     [1, 2, 3].every((i) => near(byId[ids[i]].remain, 10)),
     [1, 2, 3].map((i) => byId[ids[i]].remain));
  ok('間の3つの状態も元のまま',
     [1, 2, 3].every((i) => byId[ids[i]].status === '在庫あり'));
}

/* ------------------------------------------------------------------ */
section('1食あたりの量');
{
  const e = newEnv();
  const f = e.call('addFood', { name: 'ソイプロテイン', category: '常温', unit: 'g', tracked: true });
  const g = e.call('addFood', { name: 'オートミール', category: '乾物', unit: 'g', tracked: true });

  ok('はじめは何も設定されていない',
     Object.keys(e.call('bootstrap', {}).servings).length === 0);

  e.call('setServing', { foodId: f.food.id, per: 30 });
  e.call('setServing', { foodId: g.food.id, per: 40 });
  const sv = e.call('bootstrap', {}).servings;
  ok('食材ごとに持てる', sv[f.food.id] === 30 && sv[g.food.id] === 40, sv);

  // 0を渡したら「設定なし」に戻る。片方だけ消えて、もう片方は残る
  e.call('setServing', { foodId: f.food.id, per: 0 });
  const sv2 = e.call('bootstrap', {}).servings;
  ok('0で消せる', sv2[f.food.id] === undefined, sv2);
  ok('消しても他の食材は残る', sv2[g.food.id] === 40, sv2);

  // 設定を入れても在庫や記録の持ち方は変わらない（gのまま）
  const lot = e.call('addLots', { items: [{ foodId: g.food.id, qty: 1000, yen: 1000, unit: 'g', date: '2026-09-01' }] }).lots[0];
  e.call('record', { meal: '朝', datetime: '2026-09-02 08:00:00', entries: [{ lotId: lot.id, qty: 40 }] });
  const after = e.call('bootstrap', {}).lots.filter((l) => l.id === lot.id)[0];
  ok('量はgのまま減る', near(after.remain, 960) && after.unit === 'g', [after.remain, after.unit]);

  // 壊れた値が入っていても止まらない
  e.call('setServing', { foodId: g.food.id, per: 'あ' });
  ok('数でない値は設定にならない', e.call('bootstrap', {}).servings[g.food.id] === undefined);
}

/* ------------------------------------------------------------------ */
section('期間で割る（コーヒー）：途中から切り替えて、飲み終わりでならす');
{
  const e = newEnv('2026-10-06T03:00:00Z');   // 10/06 12:00 JST
  const f = e.call('addFood', { name: 'コーヒー100個', category: '常温', unit: '個', tracked: true });
  const lot = e.call('addLots', { items: [{ foodId: f.food.id, qty: 100, yen: 1500, unit: '個', date: '2026-09-20' }] }).lots[0];
  // 切り替える前に1杯ずつ記録していた分（10杯）
  e.call('record', { meal: '朝', datetime: '2026-09-25 08:00:00', entries: [{ lotId: lot.id, qty: 10 }] });

  const st = e.call('startPeriod', { lotId: lot.id, start: '2026-10-06' });
  ok('飲み始められる', st.ok === true, st.error);
  const spreadRows = () => e.rows('消費').filter((c) => c['種別'] === '按分');
  ok('今日の分がすぐ入る', spreadRows().length === 1 && near(spreadRows()[0]['金額'], 15), spreadRows().map((c) => c['金額']));
  ok('間食に入る', spreadRows()[0]['食事区分'] === '間食');
  ok('飲み中の一覧に出る', !!e.call('bootstrap', {}).periods[lot.id]);

  // 4日進めて開くと、抜けた日が埋まる
  e.setNow('2026-10-10T03:00:00Z');
  const b = e.call('bootstrap', {});
  ok('開いたら抜けた日が埋まる', spreadRows().length === 5, spreadRows().map((c) => c['日付']));
  ok('同じ日は二重に入らない', (e.call('bootstrap', {}), spreadRows().length === 5));
  ok('残量も1杯ずつ減る', near(b.lots.filter((l) => l.id === lot.id)[0].remain, 85));
  ok('画面に仮の量と1日の量を渡す', near(b.periods[lot.id].spent, 5) && b.periods[lot.id].per === 1 && b.periods[lot.id].start === '2026-10-06', b.periods[lot.id]);

  // 5日で飲み終わった
  const fin = e.call('finishPeriod', { lotId: lot.id, end: '2026-10-10' });
  ok('飲み終われる', fin.ok === true, fin.error);
  ok('日数と1日あたりが返る', fin.finished.days === 5 && near(fin.finished.perDay, 270), fin.finished);
  const rows = spreadRows();
  ok('毎日同じ額にならす', rows.length === 5 && rows.every((c) => near(c['金額'], 270)), rows.map((c) => c['金額']));
  const all = e.rows('消費').filter((c) => c['ロットID'] === lot.id).reduce((a, c) => a + Number(c['金額']), 0);
  ok('前の記録と合わせて、ちょうど買った値段', near(all, 1500), all);
  const l2 = e.rows('仕入').filter((l) => l['ロットID'] === lot.id)[0];
  ok('使い切りになる', Number(l2['残量']) === 0 && l2['状態'] === '使い切り', [l2['残量'], l2['状態']]);
  ok('飲み中の一覧から消える', !e.call('bootstrap', {}).periods[lot.id]);
  ok('10月の食費にも入っている', near(e.call('summary', { ym: '2026-10' }).summary.byMeal['間食'], 1350));
}

section('期間で割る：杯数を過ぎても値段を超えない');
{
  const e = newEnv('2026-10-01T03:00:00Z');
  const f = e.call('addFood', { name: 'ドリップ3個', category: '常温', unit: '個', tracked: true });
  const lot = e.call('addLots', { items: [{ foodId: f.food.id, qty: 3, yen: 300, unit: '個', date: '2026-10-01' }] }).lots[0];
  e.call('startPeriod', { lotId: lot.id, start: '2026-10-01' });
  e.setNow('2026-10-07T03:00:00Z');
  const b = e.call('bootstrap', {});
  const rows = () => e.rows('消費').filter((c) => c['種別'] === '按分');
  ok('仮の額は3日分で止まる', rows().length === 3, rows().map((c) => c['日付']));
  ok('残り0でも一覧から消えない', b.lots.some((l) => l.id === lot.id));
  const fin = e.call('finishPeriod', { lotId: lot.id, end: '2026-10-07' });
  ok('飲み終わったら7日に割り直す', fin.ok && rows().length === 7, fin.error || rows().length);
  ok('合計はちょうど値段', near(rows().reduce((a, c) => a + Number(c['金額']), 0), 300));
}

section('期間で割る：割り切れない端数、さかのぼった終わり、取り消し');
{
  const e = newEnv('2026-10-01T03:00:00Z');
  const f = e.call('addFood', { name: 'コーヒー粉', category: '常温', unit: 'g', tracked: true });
  const lot = e.call('addLots', { items: [{ foodId: f.food.id, qty: 200, yen: 1000, unit: 'g', date: '2026-10-01' }] }).lots[0];
  const rows = () => e.rows('消費').filter((c) => c['種別'] === '按分');

  // gで持っていて1食あたりが無いと、仮の額は入れない
  e.call('startPeriod', { lotId: lot.id, start: '2026-10-01' });
  ok('1食あたりが無いgは仮の額なし', rows().length === 0);
  e.call('stopPeriod', { lotId: lot.id });

  // 1食あたりを決めれば仮の額が入る
  e.call('setServing', { foodId: f.food.id, per: 10 });
  e.call('startPeriod', { lotId: lot.id, start: '2026-10-01' });
  e.setNow('2026-10-05T03:00:00Z');
  e.call('bootstrap', {});
  ok('1食あたりで仮の額が入る', rows().length === 5 && near(rows()[0]['金額'], 50), rows().map((c) => c['金額']));

  // 取り消すと全部消えて残量が戻る
  const stop = e.call('stopPeriod', { lotId: lot.id });
  ok('取り消せる', stop.ok === true, stop.error);
  ok('毎日の分が消える', rows().length === 0);
  ok('残量が戻る', near(e.rows('仕入')[0]['残量'], 200));

  // 3日で飲み終わったのを、5日目に入れる（さかのぼり）。1000円 ÷ 3日は割り切れない
  e.call('startPeriod', { lotId: lot.id, start: '2026-10-01' });
  const fin = e.call('finishPeriod', { lotId: lot.id, end: '2026-10-03' });
  ok('さかのぼって終われる', fin.ok === true, fin.error);
  ok('終わった日より後の分は消える', rows().length === 3 && rows().every((c) => c['日付'] <= '2026-10-03'),
     rows().map((c) => c['日付']));
  ok('端数を寄せて合計ぴったり', near(rows().reduce((a, c) => a + Number(c['金額']), 0), 1000),
     rows().map((c) => c['金額']));

  // 明細から按分の1日だけを消すのは断る
  const del = e.call('deleteRecord', { id: rows()[0]['消費ID'] });
  ok('按分の1日だけは消せない', del.ok === false && rows().length === 3, del);
}

section('期間で割る：おかしな日付は断る');
{
  const e = newEnv('2026-10-06T03:00:00Z');
  const f = e.call('addFood', { name: 'コーヒー', category: '常温', unit: '個', tracked: true });
  const lot = e.call('addLots', { items: [{ foodId: f.food.id, qty: 10, yen: 100, unit: '個', date: '2026-10-03' }] }).lots[0];
  ok('未来から始められない', e.call('startPeriod', { lotId: lot.id, start: '2026-10-07' }).ok === false);
  ok('買う前から始められない', e.call('startPeriod', { lotId: lot.id, start: '2026-10-01' }).ok === false);
  e.call('startPeriod', { lotId: lot.id, start: '2026-10-04' });
  ok('二重に始められない', e.call('startPeriod', { lotId: lot.id, start: '2026-10-04' }).ok === false);
  ok('始める前の日には終われない', e.call('finishPeriod', { lotId: lot.id, end: '2026-10-03' }).ok === false);
  ok('未来には終われない', e.call('finishPeriod', { lotId: lot.id, end: '2026-10-08' }).ok === false);
}

section('作り置きの食数を直す');
{
  // まだ食べていない：最初からその食数で作ったのと同じになる
  const e = newEnv('2026-10-09T03:00:00Z');
  const f = e.call('addFood', { name: '米', category: '常温', unit: 'g', tracked: true });
  const lot = e.call('addLots', { items: [{ foodId: f.food.id, qty: 1000, yen: 558.34, unit: 'g', date: '2026-10-09' }] }).lots[0];
  const mk = e.call('record', { meal: '昼', datetime: '2026-10-09 12:00:00',
                                makePrep: true, prepName: '雑穀ごはん', prepServings: 11,
                                entries: [{ lotId: lot.id, qty: 500 }] });
  ok('11食で作れる', mk.ok && mk.prepLot.qty === 11, mk.error);
  const r = e.call('resizeLot', { lotId: mk.prepLot.id, qty: 10 });
  ok('10食に直せる', r.ok === true, r.error);
  const b = e.call('bootstrap', {});
  const pl = b.lots.filter((l) => l.id === mk.prepLot.id)[0];
  ok('内容量と残りが10', pl.qty === 10 && near(pl.remain, 10), pl);
  ok('合計金額はそのまま', near(pl.yen, mk.prepLot.yen), pl.yen);
  ok('1食あたりが引き直される', near(pl.perU, mk.prepLot.yen / 10), pl.perU);
  ok('次に作るときの初期値も10', b.foods.filter((x) => x.name === '雑穀ごはん')[0].lastQty === 10);
  ok('材料の米は変わらない', near(b.lots.filter((l) => l.id === lot.id)[0].remain, 500));
}
{
  // 食べたあと：食べた分は残し、金額は新しい1食あたりで引き直す
  const e = newEnv('2026-10-09T03:00:00Z');
  const f = e.call('addFood', { name: '鶏もも肉', category: 'チルド', unit: 'g', tracked: true });
  const lot = e.call('addLots', { items: [{ foodId: f.food.id, qty: 600, yen: 1100, unit: 'g', date: '2026-10-08' }] }).lots[0];
  const mk = e.call('record', { meal: '夕', datetime: '2026-10-08 19:00:00',
                                makePrep: true, prepName: '唐揚げ', prepServings: 11,
                                entries: [{ lotId: lot.id, qty: 600 }] });
  e.call('record', { meal: '昼', datetime: '2026-10-09 12:00:00', entries: [{ lotId: mk.prepLot.id, qty: 2 }] });
  ok('2食食べると食費は200', near(e.call('summary', { ym: '2026-10' }).summary.total, 200));

  ok('食べた数より少なくはできない', e.call('resizeLot', { lotId: mk.prepLot.id, qty: 1 }).ok === false);
  const r = e.call('resizeLot', { lotId: mk.prepLot.id, qty: 10 });
  ok('食べたあとでも直せる', r.ok === true, r.error);
  const pl = e.call('bootstrap', {}).lots.filter((l) => l.id === mk.prepLot.id)[0];
  ok('残りは10−2＝8', near(pl.remain, 8), pl.remain);
  ok('食べた2食は110円ずつに引き直し', near(e.call('summary', { ym: '2026-10' }).summary.total, 220));
  ok('引き直した明細を返す', r.cons.length === 1 && near(r.cons[0].after, 220), r.cons);

  // 全部食べ切ったあとで、実は少なかった → 使い切りになる
  e.call('record', { meal: '夕', datetime: '2026-10-09 19:00:00', entries: [{ lotId: mk.prepLot.id, qty: 8 }] });
  const r2 = e.call('resizeLot', { lotId: mk.prepLot.id, qty: 10 });
  ok('食べ切ったあとも同じ数なら直せる', r2.ok === true, r2.error);
  const r3 = e.call('resizeLot', { lotId: mk.prepLot.id, qty: 12 });
  ok('増やすと残りが戻る', r3.ok && near(r3.lot.remain, 2), r3);
  const pl3 = e.call('bootstrap', {}).lots.filter((l) => l.id === mk.prepLot.id)[0];
  ok('残りが戻れば在庫ありに戻る', pl3.status === '在庫あり', pl3.status);
  ok('食べた10食の合計は食費のまま1100以下', e.call('summary', { ym: '2026-10' }).summary.total <= 1100.01);
}
{
  // 作り置きを材料にして別の作り置きを作っていた：振替先の金額も差額ぶん動く
  const e = newEnv('2026-10-09T03:00:00Z');
  const f = e.call('addFood', { name: '米', category: '常温', unit: 'g', tracked: true });
  const lot = e.call('addLots', { items: [{ foodId: f.food.id, qty: 1000, yen: 1100, unit: 'g', date: '2026-10-08' }] }).lots[0];
  const rice = e.call('record', { meal: '昼', datetime: '2026-10-08 12:00:00',
                                  makePrep: true, prepName: 'ごはん', prepServings: 11,
                                  entries: [{ lotId: lot.id, qty: 1000 }] }).prepLot;
  const oni = e.call('record', { meal: '昼', datetime: '2026-10-08 13:00:00',
                                 makePrep: true, prepName: 'おにぎり', prepServings: 4,
                                 entries: [{ lotId: rice.id, qty: 2 }] }).prepLot;
  ok('おにぎりは2食ぶん200円', near(oni.yen, 200), oni.yen);
  e.call('record', { meal: '昼', datetime: '2026-10-09 12:00:00', entries: [{ lotId: oni.id, qty: 1 }] });
  const r = e.call('resizeLot', { lotId: rice.id, qty: 10 });
  ok('材料になった作り置きも直せる', r.ok === true, r.error);
  const o2 = e.call('bootstrap', {}).lots.filter((l) => l.id === oni.id)[0];
  ok('振替先のおにぎりが220円になる', near(o2.yen, 220), o2.yen);
  ok('おにぎりの1食あたりも55円に', near(o2.perU, 55), o2.perU);
  ok('食べたおにぎり1個も55円に引き直し', near(e.call('summary', { ym: '2026-10' }).summary.total, 55));
}
{
  const e = newEnv('2026-10-09T03:00:00Z');
  const f = e.call('addFood', { name: '鶏もも肉', category: 'チルド', unit: 'g', tracked: true });
  const lot = e.call('addLots', { items: [{ foodId: f.food.id, qty: 600, yen: 900, unit: 'g', date: '2026-10-09' }] }).lots[0];
  const mk = e.call('record', { meal: '夕', datetime: '2026-10-09 19:00:00',
                                makePrep: true, prepName: 'スープ',
                                entries: [{ lotId: lot.id, qty: 300 }] });
  ok('％の作り置きは断る', e.call('resizeLot', { lotId: mk.prepLot.id, qty: 4 }).ok === false);
  ok('0は断る', e.call('resizeLot', { lotId: lot.id, qty: 0 }).ok === false);
  ok('ロットIDが無ければ断る', e.call('resizeLot', { qty: 3 }).ok === false);
}

console.log('\n────────────────────────');
console.log(`  ${pass} 件成功 / ${fail} 件失敗`);
console.log('────────────────────────');
process.exit(fail ? 1 : 0);
