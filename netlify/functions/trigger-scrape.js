// ===== Netlify Function: GitHub Actionsのスクレイパーをトリガーする =====
// iPhoneから「今すぐ更新」ボタンを押したとき、
// GitHub Actionsのworkflow_dispatchイベントを発火させる

export default async (req) => {
  // POSTリクエスト以外は拒否
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // 環境変数からGitHub情報を取得
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;   // GitHubのPersonal Access Token
  const GITHUB_REPO = process.env.GITHUB_REPO;     // 例: "kimu-k23/hotel-price-tracker-v2"
  const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return new Response(
      JSON.stringify({ error: '環境変数が設定されていません' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    // GitHub Actions の workflow_dispatch API を呼ぶ
    // ワークフローファイル名は scrape.yml
    const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/scrape.yml/dispatches`;

    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: GITHUB_BRANCH  // どのブランチで実行するか
      })
    });

    // 204 No Content が成功レスポンス
    if (res.status === 204) {
      return new Response(
        JSON.stringify({ success: true, message: '価格更新を開始しました' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // エラーの場合
    const errorData = await res.json();
    throw new Error(errorData.message || `GitHub API エラー (${res.status})`);

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
