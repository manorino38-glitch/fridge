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

console.log('\n────────────────────────');
console.log(`  ${pass} 件成功 / ${fail} 件失敗`);
console.log('────────────────────────');
process.exit(fail ? 1 : 0);
