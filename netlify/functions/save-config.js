// ===== Netlify Function: 設定をGitHubに保存する =====
// iPhoneからホテル情報を追加/削除したとき、
// GitHub上のconfig.jsonを更新する中継役（プロキシ）

export default async (req) => {
  // POSTリクエスト以外は拒否
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // 環境変数からGitHub情報を取得（Netlifyの管理画面で設定する）
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;       // GitHubのPersonal Access Token
  const GITHUB_REPO = process.env.GITHUB_REPO;         // 例: "kimu-k23/hotel-price-tracker-v2"
  const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

  // 環境変数が設定されていない場合のエラー
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return new Response(
      JSON.stringify({ error: '環境変数が設定されていません' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    // リクエストボディ（新しい設定データ）を取得
    const newConfig = await req.json();

    // GitHub APIのURL（config.jsonファイルを指定）
    const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/data/config.json`;

    // まず現在のファイルのSHA（バージョン識別子）を取得する
    // ※ GitHubでファイルを更新するにはSHAが必要
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

    // ファイルの内容をBase64エンコード（GitHub APIの仕様）
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(newConfig, null, 2))));

    // GitHub APIでファイルを更新（または新規作成）
    const updateBody = {
      message: '設定を更新',
      content: content,
      branch: GITHUB_BRANCH,
    };

    // SHAがある場合は更新、ない場合は新規作成
    if (sha) {
      updateBody.sha = sha;
    }

    const updateRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updateBody)
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
