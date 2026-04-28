// ===== Netlify Function: 価格データをGitHubに保存する =====
// Edge Functionで取得した価格データを、GitHubのprices.jsonに書き込む中継役。
// save-config.jsと同じ仕組みで、保存対象のファイルだけが異なる。

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
  const GITHUB_REPO   = process.env.GITHUB_REPO;
  const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return new Response(
      JSON.stringify({ error: '環境変数が設定されていません' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const newPrices = await req.json();

    // GitHub APIでprices.jsonを更新する
    const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/data/prices.json`;

    // 現在のファイルのSHA（更新に必要なバージョン識別子）を取得
    const getRes = await fetch(apiUrl, {
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
      }
    });

    let sha = null;
    if (getRes.ok) {
      const fileData = await getRes.json();
      sha = fileData.sha;
    }

    // JSONをBase64エンコード（GitHub APIの仕様）
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(newPrices, null, 2))));

    const updateBody = {
      message: '価格データを更新',
      content,
      branch: GITHUB_BRANCH,
    };
    if (sha) updateBody.sha = sha;

    const updateRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updateBody),
    });

    if (!updateRes.ok) {
      const errorData = await updateRes.json();
      throw new Error(errorData.message || '更新に失敗しました');
    }

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
