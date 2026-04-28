// ===== Netlify Edge Function: 価格取得プロキシ =====
// Edge Functionはユーザーに最も近いサーバーで実行される。
// 日本のユーザー → 東京サーバー → Yahoo!トラベルAPIにアクセス可能。
// GitHub Actions（米国）では403になるため、この方式を使う。

const GRAPHQL_URL = 'https://travel.yahoo.co.jp/graphql?lang=ja-JP';

const GRAPHQL_QUERY = `
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
`;

// URLからaccommodationId/planId/roomIdを抽出する
function extractIdsFromUrl(url) {
  const accomMatch = url.match(/travel\.yahoo\.co\.jp\/(\d+)\//);
  const planMatch  = url.match(/pln=(\d+)/);
  const roomMatch  = url.match(/rm=(\d+)/);

  if (!accomMatch || !planMatch || !roomMatch) return null;

  return {
    accommodationId: accomMatch[1],
    planId: planMatch[1],
    roomId: roomMatch[1],
  };
}

// 1ホテル分の価格カレンダーを取得
async function fetchHotelPrices(hotel) {
  const ids = extractIdsFromUrl(hotel.url);
  if (!ids) {
    return { id: hotel.id, name: hotel.name, dates: [], error: 'URL解析失敗' };
  }

  const variables = {
    accommodationId: ids.accommodationId,
    roomId: ids.roomId,
    planId: ids.planId,
    input: {
      lodgingCount: 1,
      peopleCount: 2,
      roomCount: 1,
      searchType: "1",
      discount: true,
      startDate: hotel.dateFrom,
      endDate: hotel.dateTo,
      preview: false,
    },
    currency: "JPY",
  };

  const payload = [{
    query: GRAPHQL_QUERY,
    variables,
    operationName: "Search",
  }];

  const resp = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Referer': `https://travel.yahoo.co.jp/${ids.accommodationId}/`,
      'Origin': 'https://travel.yahoo.co.jp',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    return { id: hotel.id, name: hotel.name, dates: [], error: `HTTP ${resp.status}` };
  }

  const data = await resp.json();
  const calendar = data[0]?.data?.accommodation?.roomPlan?.calendar;

  if (!calendar) {
    return { id: hotel.id, name: hotel.name, dates: [], error: 'レスポンス解析失敗' };
  }

  // 価格データに変換
  const dates = calendar.map(entry => {
    const amount = entry.amount || 0;
    const discount = entry.discountAmount || 0;
    if (amount > 0) {
      return { date: entry.date, price: discount > 0 ? discount : amount };
    }
    return { date: entry.date, price: null };
  });

  return { id: hotel.id, name: hotel.name, dates };
}

export default async (request, context) => {
  // POSTリクエストのみ受け付ける
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    // リクエストボディからホテルリストを取得
    const { hotels } = await request.json();

    if (!hotels || !hotels.length) {
      return Response.json({ error: 'ホテルデータがありません' }, { status: 400 });
    }

    // 全ホテルの価格を並列取得
    const results = await Promise.all(hotels.map(fetchHotelPrices));

    const pricesData = {
      lastUpdated: new Date().toISOString(),
      hotels: results,
    };

    return Response.json(pricesData);

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
};

export const config = {
  path: "/api/fetch-prices",
};
