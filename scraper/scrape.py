#!/usr/bin/env python3
"""
ホテル価格スクレイパー（GitHub Actions版）

GitHub Actions上で動作する。Macは不要。
Yahoo!トラベルのGraphQL APIから価格カレンダーを取得し、
prices.jsonを更新する。

仕組み:
1. URLからaccommodationId/planId/roomIdを抽出
2. Playwrightで一瞬だけページを開いてCookieを取得
3. requestsでGraphQL APIに直接クエリを投げる
4. calendarデータ（日付・価格・割引価格）を保存
5. GitHub Actionsがcommit & pushを担当（このスクリプトではやらない）
"""

import json, os, re, sys, time, requests
from datetime import datetime
from playwright.sync_api import sync_playwright

# GitHub Actionsではリポジトリのルートが作業ディレクトリ
# ローカルでも動くように、環境変数またはスクリプト位置から判定
SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.environ.get('GITHUB_WORKSPACE', os.path.dirname(SCRIPT_DIR))
CONFIG_PATH = os.path.join(PROJECT_DIR, 'data', 'config.json')
PRICES_PATH = os.path.join(PROJECT_DIR, 'data', 'prices.json')

GRAPHQL_URL = 'https://travel.yahoo.co.jp/graphql?lang=ja-JP'
USER_AGENT  = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
               'AppleWebKit/537.36 (KHTML, like Gecko) '
               'Chrome/120.0.0.0 Safari/537.36')


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def load_config():
    """config.jsonを読み込む"""
    try:
        with open(CONFIG_PATH, encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        log(f"config.json が見つかりません: {CONFIG_PATH}")
        return {"hotels": []}


def load_existing_prices():
    """既存のprices.jsonを読み込む（空データ防止用）"""
    try:
        with open(PRICES_PATH, encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"lastUpdated": None, "hotels": []}


def save_prices(data):
    """prices.jsonを保存する"""
    with open(PRICES_PATH, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    log("prices.json 保存完了")


def extract_ids_from_url(url):
    """
    Yahoo!トラベルのURLからaccommodationId/planId/roomIdを抽出する。
    例: https://travel.yahoo.co.jp/00002494/?...&pln=11590366&...&rm=10090696...
    """
    accom = re.search(r'travel\.yahoo\.co\.jp/(\d+)/', url)
    plan  = re.search(r'pln=(\d+)', url)
    room  = re.search(r'rm=(\d+)', url)

    if not (accom and plan and room):
        return None, None, None

    return accom.group(1), plan.group(1), room.group(1)


def get_cookies(url, context):
    """
    Playwrightでページを開いてCookieを取得する。
    GitHub Actions（海外サーバー）ではCookieが取得できない場合があるため、
    まずYahoo!トラベルのトップページにアクセスしてセッションを確立してから
    対象ページにアクセスする。
    """
    page = context.new_page()
    try:
        # まずトップページにアクセスしてセッションCookieを取得
        page.goto('https://travel.yahoo.co.jp/', wait_until='domcontentloaded', timeout=20000)
        time.sleep(2)
        # 次に対象ページにアクセス
        page.goto(url, wait_until='domcontentloaded', timeout=20000)
        time.sleep(3)
    except Exception as e:
        log(f"  Cookie取得中のエラー（続行）: {e}")
    finally:
        page.close()

    cookies = context.cookies()
    # yahoo.co.jpドメインのCookieのみ使用
    return '; '.join([
        f"{c['name']}={c['value']}"
        for c in cookies
        if 'yahoo' in c.get('domain', '') or 'ikyu' in c.get('domain', '')
    ])


def fetch_calendar(accommodation_id, room_id, plan_id, date_from, date_to, cookies_str):
    """
    GraphQL APIにカレンダークエリを投げて価格データを取得する。

    返すデータ形式:
    [{"date": "2026-09-15", "price": 24860}, {"date": "2026-09-19", "price": null}, ...]
    - price = discountAmount（割引後価格） ※Yahoo!トラベルに表示される価格
    - price = null の場合は空室なし（amount=0）
    """
    query = """
query Search(
  $accommodationId: AccommodationIdScalar!,
  $roomId: RoomIdScalar!,
  $planId: PlanIdScalar!,
  $planUwanosePointVariation: PlanUwanosePointVariationScalar! = 0,
  $input: RoomPlanCalendarInput!,
  $currency: Currency!
) {
  accommodation(accommodationId: $accommodationId) {
    roomPlan(
      roomId: $roomId
      planId: $planId
      planUwanosePointVariation: $planUwanosePointVariation
    ) {
      calendar(input: $input) {
        date
        amount(currency: $currency)
        discountAmount(currency: $currency)
        holiday
      }
    }
  }
}
"""

    variables = {
        "accommodationId": accommodation_id,
        "roomId": room_id,
        "planId": plan_id,
        "input": {
            "lodgingCount": 1,
            "peopleCount": 2,
            "roomCount": 1,
            "searchType": "1",
            "discount": True,
            "startDate": date_from,
            "endDate": date_to,
            "preview": False
        },
        "currency": "JPY"
    }

    headers = {
        'Content-Type': 'application/json',
        'Referer': f'https://travel.yahoo.co.jp/{accommodation_id}/',
        'Origin': 'https://travel.yahoo.co.jp',
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Accept-Language': 'ja,en;q=0.9',
    }

    # Cookieがあれば付与
    if cookies_str:
        headers['Cookie'] = cookies_str

    payload = [{"query": query, "variables": variables, "operationName": "Search"}]

    # 最初のリクエスト（Cookieあり or なし）
    resp = requests.post(GRAPHQL_URL, json=payload, headers=headers, timeout=30)

    # 403の場合、Cookieなしでリトライ
    if resp.status_code == 403 and cookies_str:
        log("  403エラー → Cookieなしでリトライ...")
        headers.pop('Cookie', None)
        resp = requests.post(GRAPHQL_URL, json=payload, headers=headers, timeout=30)

    # それでも403なら、ペイロードをリスト→単体に変えてリトライ
    if resp.status_code == 403:
        log("  403エラー → 単体ペイロードでリトライ...")
        single_payload = {"query": query, "variables": variables, "operationName": "Search"}
        resp = requests.post(GRAPHQL_URL, json=single_payload, headers=headers, timeout=30)

    resp.raise_for_status()

    data = resp.json()
    # レスポンスがリスト形式か単体かを判定
    if isinstance(data, list):
        calendar = data[0]['data']['accommodation']['roomPlan']['calendar']
    else:
        calendar = data['data']['accommodation']['roomPlan']['calendar']

    # 価格データに変換
    results = []
    for entry in calendar:
        date_str = entry['date']
        amount = entry.get('amount', 0)
        discount = entry.get('discountAmount', 0)

        if amount > 0:
            price = discount if discount > 0 else amount
            results.append({"date": date_str, "price": price})
        else:
            results.append({"date": date_str, "price": None})

    return results


def scrape_hotel(hotel, context):
    """1ホテル分の価格を取得する"""
    log(f"ホテル: {hotel['name']}")

    url       = hotel['url']
    date_from = hotel['dateFrom']
    date_to   = hotel['dateTo']

    # URLからID抽出
    accommodation_id, plan_id, room_id = extract_ids_from_url(url)
    if not accommodation_id:
        log("  URLからIDを抽出できませんでした（Yahoo!トラベルのURLを確認してください）")
        return []

    log(f"  accommodationId={accommodation_id}, planId={plan_id}, roomId={room_id}")

    # Cookie取得
    log("  Cookieを取得中...")
    cookies_str = get_cookies(url, context)
    log(f"  Cookie: {len(cookies_str)}文字")

    # GraphQL APIで価格取得
    log(f"  APIで価格取得中（{date_from} 〜 {date_to}）...")
    dates_list = fetch_calendar(accommodation_id, room_id, plan_id, date_from, date_to, cookies_str)

    got  = sum(1 for d in dates_list if d['price'] is not None)
    none = sum(1 for d in dates_list if d['price'] is None)
    log(f"  合計: {len(dates_list)}日分 / 価格あり:{got}日 / 空室なし:{none}日")

    if got > 0:
        log(f"  価格例: {[d for d in dates_list if d['price']][:3]}")

    return dates_list


def main():
    log("=" * 40)
    log("ホテル価格スクレイパー（GitHub Actions版）開始")
    log("=" * 40)

    config = load_config()

    if not config.get('hotels'):
        log("登録ホテルなし。終了。")
        return

    log(f"登録ホテル数: {len(config['hotels'])}")

    # 既存データを読み込む（空データ防止用）
    existing_prices = load_existing_prices()

    prices_data = {
        "lastUpdated": datetime.now().isoformat(),
        "hotels": []
    }

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            locale='ja-JP',
            user_agent=USER_AGENT
        )

        for hotel in config['hotels']:
            try:
                dates = scrape_hotel(hotel, context)
            except Exception as e:
                log(f"  エラー: {e}")
                dates = []

            prices_data['hotels'].append({
                "id":    hotel['id'],
                "name":  hotel['name'],
                "dates": dates
            })
            time.sleep(1)

        browser.close()

    # ===== 空データ防止ガード =====
    # 全ホテルの取得データが0件の場合、既存データを上書きしない
    total_dates = sum(len(h['dates']) for h in prices_data['hotels'])
    if total_dates == 0 and existing_prices.get('hotels'):
        # 既存データに価格があるなら上書きしない
        existing_total = sum(len(h.get('dates', [])) for h in existing_prices['hotels'])
        if existing_total > 0:
            log("⚠️ 全ホテルの取得データが0件です。既存データを保護するため上書きしません。")
            sys.exit(1)

    save_prices(prices_data)
    log("完了！")


if __name__ == '__main__':
    main()
