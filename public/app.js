// ===== ホテル価格トラッカー v2 メインスクリプト =====
// バックエンド: GitHub Actions（Mac不要・スマホだけで完結）

let config = { hotels: [] };
let prices  = { hotels: [] };

// 現在開いているカレンダーのホテルID（nullなら閉じている）
let openCalendarId = null;

// GitHubのrawコンテンツURL（常に最新データを取得できる）
// ★ ここを新しいリポジトリ名に変更してください
const GITHUB_RAW = 'https://raw.githubusercontent.com/kimu-k23/hotel-price-tracker-v2/main';

document.addEventListener('DOMContentLoaded', async () => {
  await loadData();
  renderHotelList();
  updateLastUpdated();
  setupEventListeners();
});

// --- データ読み込み ---
async function loadData() {
  try {
    // GitHubから直接読む（Netlifyのキャッシュを使わない）
    const r = await fetch(GITHUB_RAW + '/data/config.json?t=' + Date.now());
    if (r.ok) config = await r.json();
  } catch (e) { /* 初回は空 */ }
  try {
    const r = await fetch(GITHUB_RAW + '/data/prices.json?t=' + Date.now());
    if (r.ok) prices = await r.json();
  } catch (e) { /* 初回は空 */ }
}

// --- 最終更新日時 ---
function updateLastUpdated() {
  const el = document.getElementById('lastUpdated');
  if (prices.lastUpdated) {
    const d = new Date(prices.lastUpdated);
    el.textContent = `最終更新: ${d.toLocaleDateString('ja-JP')} ${d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;
  } else {
    el.textContent = '最終更新: まだデータがありません';
  }
}

// --- イベント設定 ---
function setupEventListeners() {
  document.getElementById('addHotelBtn').addEventListener('click', addHotel);
}

// --- 今すぐ更新（Edge Functionで日本サーバーから価格取得） ---
async function triggerScrape() {
  const btn  = document.getElementById('refreshBtn');
  const icon = document.getElementById('refreshIcon');
  const note = document.getElementById('refreshNote');

  if (config.hotels.length === 0) {
    note.textContent = 'ホテルを追加してから更新してください';
    return;
  }

  btn.disabled = true;
  icon.classList.add('spinning');
  note.textContent = '価格を取得中...（数秒かかります）';

  try {
    // Edge Functionで価格取得（日本のサーバーから実行 → Yahoo!トラベルにアクセス可能）
    const fetchRes = await fetch('/api/fetch-prices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hotels: config.hotels }),
    });

    if (!fetchRes.ok) {
      const err = await fetchRes.json();
      throw new Error(err.error || '価格取得に失敗しました');
    }

    const newPrices = await fetchRes.json();
    note.textContent = '取得完了！保存中...';

    // 取得した価格データをGitHubに保存
    const saveRes = await fetch('/.netlify/functions/save-prices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newPrices),
    });

    if (!saveRes.ok) {
      const err = await saveRes.json();
      throw new Error(err.error || '保存に失敗しました');
    }

    note.textContent = '保存しました！データを読み込み中...';

    // GitHubのキャッシュ反映を少し待ってからリロード
    await new Promise(resolve => setTimeout(resolve, 3000));
    await loadData();
    renderHotelList();
    updateLastUpdated();
    note.textContent = '更新完了！';
    setTimeout(() => { note.textContent = ''; }, 3000);

  } catch (e) {
    note.textContent = 'エラー: ' + e.message;
  } finally {
    btn.disabled = false;
    icon.classList.remove('spinning');
  }
}

// --- ホテル追加 ---
async function addHotel() {
  const name      = document.getElementById('hotelName').value.trim();
  const url       = document.getElementById('hotelUrl').value.trim();
  const dateFrom  = document.getElementById('dateFrom').value;
  const dateTo    = document.getElementById('dateTo').value;
  const threshold = parseInt(document.getElementById('priceThreshold').value);

  if (!name)                             return alert('ホテル名を入力してください');
  if (!url)                              return alert('URLを入力してください');
  if (!url.includes('travel.yahoo.co.jp')) return alert('Yahoo!トラベルのURLを入力してください');
  if (!dateFrom || !dateTo)              return alert('チェック期間を指定してください');
  if (dateFrom >= dateTo)                return alert('終了日は開始日より後にしてください');
  if (!threshold || threshold <= 0)      return alert('通知価格を入力してください');

  const newHotel = { id: Date.now().toString(), name, url, dateFrom, dateTo, priceThreshold: threshold };
  config.hotels.push(newHotel);

  try {
    const res = await fetch('/.netlify/functions/save-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    if (!res.ok) throw new Error('保存に失敗しました');

    ['hotelName','hotelUrl','dateFrom','dateTo','priceThreshold'].forEach(id => {
      document.getElementById(id).value = '';
    });
    renderHotelList();
    alert('ホテルを追加しました！\n「今すぐ更新」ボタンを押すと価格を取得できます。');
  } catch (e) {
    config.hotels.pop();
    alert('保存に失敗しました: ' + e.message);
  }
}

// --- ホテル削除 ---
async function deleteHotel(hotelId) {
  if (!confirm('このホテルを削除しますか？')) return;
  config.hotels = config.hotels.filter(h => h.id !== hotelId);
  try {
    await fetch('/.netlify/functions/save-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    // 開いていたカレンダーを閉じる
    if (openCalendarId === hotelId) {
      openCalendarId = null;
      document.getElementById('calendarSection').style.display = 'none';
    }
    renderHotelList();
  } catch (e) {
    alert('削除に失敗しました: ' + e.message);
  }
}

// --- 設定をサーバーに保存する共通関数 ---
async function saveConfig() {
  const res = await fetch('/.netlify/functions/save-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  });
  if (!res.ok) throw new Error('保存に失敗しました');
}

// --- 閾値価格の編集 ---
async function editThreshold(hotelId) {
  const hotel = config.hotels.find(h => h.id === hotelId);
  if (!hotel) return;

  const input = prompt('強調表示する価格（円）を入力:', hotel.priceThreshold);
  if (input === null) return; // キャンセル

  const newVal = parseInt(input);
  if (!newVal || newVal <= 0) return alert('正しい金額を入力してください');

  const oldVal = hotel.priceThreshold;
  hotel.priceThreshold = newVal;

  try {
    await saveConfig();
    renderHotelList();
    // カレンダーが開いていたら再描画
    if (openCalendarId === hotelId) showCalendar(hotelId);
  } catch (e) {
    hotel.priceThreshold = oldVal;
    alert('保存に失敗しました: ' + e.message);
  }
}

// --- 日付の編集 ---
async function editDates(hotelId) {
  const hotel = config.hotels.find(h => h.id === hotelId);
  if (!hotel) return;

  const newFrom = prompt('チェック開始日（例: 2026-09-15）:', hotel.dateFrom);
  if (newFrom === null) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newFrom)) return alert('日付の形式が正しくありません（例: 2026-09-15）');

  const newTo = prompt('チェック終了日（例: 2026-11-19）:', hotel.dateTo);
  if (newTo === null) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newTo)) return alert('日付の形式が正しくありません（例: 2026-11-19）');

  if (newFrom >= newTo) return alert('終了日は開始日より後にしてください');

  const oldFrom = hotel.dateFrom;
  const oldTo = hotel.dateTo;
  hotel.dateFrom = newFrom;
  hotel.dateTo = newTo;

  try {
    await saveConfig();
    renderHotelList();
    if (openCalendarId === hotelId) showCalendar(hotelId);
    alert('日付を変更しました！\n「今すぐ更新」ボタンを押すと新しい期間の価格を取得できます。');
  } catch (e) {
    hotel.dateFrom = oldFrom;
    hotel.dateTo = oldTo;
    alert('保存に失敗しました: ' + e.message);
  }
}

// --- ホテル一覧描画 ---
function renderHotelList() {
  const container = document.getElementById('hotelList');
  if (config.hotels.length === 0) {
    container.innerHTML = '<p class="empty-message">ホテルが登録されていません</p>';
    return;
  }
  container.innerHTML = config.hotels.map(hotel => {
    const hotelPrices = prices.hotels.find(h => h.id === hotel.id);
    let minPriceHtml = '';
    if (hotelPrices?.dates?.length) {
      const valid = hotelPrices.dates.filter(d => d.price !== null);
      if (valid.length) {
        const minPrice = Math.min(...valid.map(d => d.price));
        const isBelowThreshold = minPrice <= hotel.priceThreshold;
        minPriceHtml = `<p class="hotel-min-price">最安: ¥${minPrice.toLocaleString()}${isBelowThreshold ? ' ✓' : ''}</p>`;
      }
    }
    // カレンダーが開いているかどうかでボタンテキストを変える
    const isOpen = openCalendarId === hotel.id;
    const calBtnText = isOpen ? '閉じる' : 'カレンダー';
    const calBtnClass = isOpen ? 'btn btn-view active' : 'btn btn-view';

    return `
      <div class="hotel-item">
        <div class="hotel-item-header">
          <div class="hotel-item-info">
            <h3>${escapeHtml(hotel.name)}</h3>
            <a href="${escapeHtml(hotel.url)}" target="_blank" rel="noopener" class="hotel-plan-link">
              <i class="fas fa-external-link-alt"></i> Yahoo!トラベル プランURL
            </a>
            <p class="hotel-period">
              ${hotel.dateFrom} 〜 ${hotel.dateTo}
              <button class="btn-edit" onclick="editDates('${hotel.id}')" title="日付を編集">
                <i class="fas fa-pen"></i>
              </button>
            </p>
            <p class="hotel-threshold">
              ¥${hotel.priceThreshold.toLocaleString()} 以下で強調
              <button class="btn-edit" onclick="editThreshold('${hotel.id}')" title="閾値を編集">
                <i class="fas fa-pen"></i>
              </button>
            </p>
            ${minPriceHtml}
          </div>
          <div class="hotel-item-actions">
            <button class="${calBtnClass}" onclick="toggleCalendar('${hotel.id}')">${calBtnText}</button>
            <button class="btn btn-danger" onclick="deleteHotel('${hotel.id}')">削除</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

// --- カレンダー トグル（開閉切り替え） ---
function toggleCalendar(hotelId) {
  const section = document.getElementById('calendarSection');
  if (openCalendarId === hotelId) {
    // 同じホテルをもう一度押したら閉じる
    openCalendarId = null;
    section.style.display = 'none';
    renderHotelList(); // ボタン表示を更新
  } else {
    // 別のホテルまたは初めて開く
    showCalendar(hotelId);
  }
}

// --- カレンダー表示 ---
function showCalendar(hotelId) {
  const hotel = config.hotels.find(h => h.id === hotelId);
  if (!hotel) return;

  openCalendarId = hotelId;

  const section     = document.getElementById('calendarSection');
  const title       = document.getElementById('calendarTitle');
  const view        = document.getElementById('calendarView');
  const alertSec    = document.getElementById('alertList');
  const alertItems  = document.getElementById('alertItems');

  title.innerHTML = `<i class="fas fa-calendar-alt"></i> ${escapeHtml(hotel.name)}`;
  section.style.display = 'block';

  // 価格マップ作成（date文字列 → price）
  const hotelPrices = prices.hotels.find(h => h.id === hotelId);
  const priceMap = {};
  if (hotelPrices?.dates) {
    hotelPrices.dates.forEach(d => { priceMap[d.date] = d.price; });
  }

  const startDate = new Date(hotel.dateFrom);
  const endDate   = new Date(hotel.dateTo);
  let html = '';
  const alerts = [];

  // 月ごとにカレンダー生成
  let cur = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  while (cur <= endDate) {
    html += renderMonth(cur.getFullYear(), cur.getMonth(), startDate, endDate, priceMap, hotel.priceThreshold, hotel.url, alerts);
    cur.setMonth(cur.getMonth() + 1);
  }

  view.innerHTML = html;

  // お得な日程リスト
  if (alerts.length > 0) {
    alertSec.style.display = 'block';
    alertItems.innerHTML = alerts
      .sort((a, b) => a.price - b.price)
      .map(a => `<li><span>${a.date}</span><span class="alert-price">¥${a.price.toLocaleString()}</span></li>`)
      .join('');
  } else {
    alertSec.style.display = 'none';
  }

  // ボタン表示を更新してからスクロール
  renderHotelList();
  section.scrollIntoView({ behavior: 'smooth' });
}

// --- 月カレンダー生成 ---
function renderMonth(year, month, rangeStart, rangeEnd, priceMap, threshold, hotelUrl, alerts) {
  const dayNames = ['日','月','火','水','木','金','土'];
  const firstDay = new Date(year, month, 1).getDay();
  const lastDate = new Date(year, month + 1, 0).getDate();

  let html = `<div class="calendar-month"><h4>${year}年${month + 1}月</h4><div class="calendar-grid">`;

  // 曜日ヘッダー
  dayNames.forEach(n => { html += `<div class="calendar-day-header">${n}</div>`; });

  // 空白セル
  for (let i = 0; i < firstDay; i++) html += '<div class="calendar-day empty"></div>';

  // 日付セル
  for (let day = 1; day <= lastDate; day++) {
    const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const dateObj = new Date(year, month, day);
    const dow     = dateObj.getDay();
    const inRange = dateObj >= rangeStart && dateObj <= rangeEnd;

    const price    = priceMap[dateStr];
    const isDeal   = inRange && price != null && price <= threshold;
    const noVacancy = inRange && price === null && dateStr in priceMap;

    if (isDeal) alerts.push({ date: dateStr, price });

    // セルのクラス決定
    let cls = 'calendar-day';
    if (!inRange)      cls += ' empty';
    else if (isDeal)   cls += ' deal';
    else if (noVacancy) cls += ' no-vacancy';
    else if (inRange && !(dateStr in priceMap)) cls += ' no-data';

    if (dow === 0) cls += ' sunday';
    if (dow === 6) cls += ' saturday';

    // 範囲内の日付はタップでYahoo!トラベルに飛べるようにする
    const clickAttr = inRange ? ` onclick="window.open('${escapeHtml(hotelUrl)}', '_blank')"` : '';
    if (inRange) cls += ' clickable';

    // 価格テキスト
    let priceHtml = '';
    if (inRange) {
      if (price != null) {
        const formatted = price.toLocaleString();
        priceHtml = `<span class="day-price">${formatted}<br>円</span>`;
      } else if (dateStr in priceMap) {
        priceHtml = `<span class="day-price" style="font-size:0.6rem;color:#c8b8b0;">空室<br>なし</span>`;
      } else {
        priceHtml = `<span class="day-price">---</span>`;
      }
    }

    html += `
      <div class="${cls}"${clickAttr}>
        <span class="day-number">${inRange ? day : ''}</span>
        ${priceHtml}
      </div>`;
  }

  html += '</div></div>';
  return html;
}

// --- XSS対策 ---
function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}
