#!/usr/bin/env python3
"""
ホテル価格スクレイパー（GitHub Actions版）

GitHub Actions上で動作する。Macは不要。
Yahoo!トラベルのGraphQL APIから価格カレンダーを取得し、
prices.jsonを更新する。

仕組み:
1. URLからaccommodationId/planId/roomIdを抽出
2. Playwrightでページを開く
3. ブラウザ内からfetch()でGraphQL APIを叩く（Cookie/ヘッダーは自動処理）
4. calendarデータ（日付・価格・割引価格）を保存
5. GitHub Actionsがcommit & pushを担当
"""

import json, os, re, sys, time
from datetime import datetime
from playwright.sync_api import sync_playwright

# GitHub Actionsではリポジトリのルートが作業ディレクトリ
SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.environ.get('GITHUB_WORKSPACE', os.path.dirname(SCRIPT_DIR))
CONFIG_PATH = os.path.join(PROJECT_DIR, 'data', 'config.json')
PRICES_PATH = os.path.join(PROJECT_DIR, 'data', 'prices.json')

GRAPHQL_URL = 'https://travel.yahoo.co.jp/graphql?lang=ja-JP'
USER_AGENT  = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
               'AppleWebKit/537.36 (KHTML, like Gecko) '
               'Chrome/120.0.0.0 Safari/537.36')

# GraphQLクエリ（ブラウザ内で実行する）
GRAPHQL_QUERY = """
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


def fetch_calendar_via_browser(page, accommodation_id, room_id, plan_id, date_from, date_to):
    """
    ブラウザ内からfetch()でGraphQL APIを呼ぶ。
    ブラウザのセッション（Cookie、Referer等）が自動で付与されるため、
    海外IPからでもAPIにアクセスできる可能性が高い。
    """
    # JavaScriptでfetch()を実行し、結果をPythonに返す
    js_code = """
    async ([query, variables]) => {
        const payload = [{
            query: query,
            variables: variables,
            operationName: "Search"
        }];
        const resp = await fetch('https://travel.yahoo.co.jp/graphql?lang=ja-JP', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!resp.ok) {
            return { error: `HTTP ${resp.status}`, status: resp.status };
        }
        return await resp.json();
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

    result = page.evaluate(js_code, [GRAPHQL_QUERY, variables])

    # エラーチェック
    if isinstance(result, dict) and 'error' in result:
        raise Exception(f"GraphQL APIエラー: {result['error']}")

    # レスポンス解析
    if isinstance(result, list):
        calendar = result[0]['data']['accommodation']['roomPlan']['calendar']
    else:
        calendar = result['data']['accommodation']['roomPlan']['calendar']

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

    # ページを開いてセッションを確立
    log("  ページを開いてセッション確立中...")
    page = context.new_page()
    try:
        page.goto(url, wait_until='domcontentloaded', timeout=30000)
        time.sleep(3)
        log(f"  ページタイトル: {page.title()}")

        # ブラウザ内からGraphQL APIを呼ぶ
        log(f"  ブラウザ内fetch()で価格取得中（{date_from} 〜 {date_to}）...")
        dates_list = fetch_calendar_via_browser(
            page, accommodation_id, room_id, plan_id, date_from, date_to
        )

        got  = sum(1 for d in dates_list if d['price'] is not None)
        none = sum(1 for d in dates_list if d['price'] is None)
        log(f"  合計: {len(dates_list)}日分 / 価格あり:{got}日 / 空室なし:{none}日")

        if got > 0:
            log(f"  価格例: {[d for d in dates_list if d['price']][:3]}")

        return dates_list

    except Exception as e:
        log(f"  エラー: {e}")
        return []
    finally:
        page.close()


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
            user_agent=USER_AGENT,
            # 日本のタイムゾーンを設定
            timezone_id='Asia/Tokyo',
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
        existing_total = sum(len(h.get('dates', [])) for h in existing_prices['hotels'])
        if existing_total > 0:
            log("⚠️ 全ホテルの取得データが0件です。既存データを保護するため上書きしません。")
            sys.exit(1)

    save_prices(prices_data)
    log("完了！")


if __name__ == '__main__':
    main()
