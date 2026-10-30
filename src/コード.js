/**
 * Slackの特定チャンネルの新着メッセージを取得して、
 * Gmailを使って、指定のメールアドレスへまとめて送信する。
 *
 * 必須スクリプトプロパティ:
 * - SLACK_BOT_TOKEN
 * - SLACK_CHANNEL_ID
 * - MAIL_TO
 *
 * 任意: SLACK_USER_TOKEN（Botでスレッド取得できない場合）
 *
 * 自動生成:
 * - LAST_TS
 * - SLACK_USER_<USER_ID>
 */

const TIME_ZONE = 'Asia/Tokyo';
const MAX_SCAN_MILLISECONDS = 4 * 60 * 1000;
const MAX_SCAN_REQUESTS = 200;

/**
 * Slack新着メッセージを確認してメール送信する。
 * 時間主導トリガーから定期実行する想定。
 */
function checkSlackMessages() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    forwardSlackMessages_();
  } finally {
    lock.releaseLock();
  }
}

function forwardSlackMessages_() {
  const props = PropertiesService.getScriptProperties();

  const token = requireProperty_(props, 'SLACK_BOT_TOKEN');
  const channelId = requireProperty_(props, 'SLACK_CHANNEL_ID');
  const mailTo = requireProperty_(props, 'MAIL_TO');

  const lastTs = props.getProperty('LAST_TS') || '0';

  const threadToken = props.getProperty('SLACK_USER_TOKEN') || token;
  const messages = fetchSlackMessages_(token, channelId, lastTs, threadToken);

  if (messages.length === 0) {
    console.log('新着メッセージはありません。');
    return;
  }

  // 通常投稿と返信は取得時に重複を除去し、古い順に整列済み。

  const body = messages
    .map((message, index) => {
      return formatMessage_(token, message, index + 1);
    })
    .join('\n\n----------------------------------------\n\n');

  const subject =
    `[Slack] ${messages.length}件の新着メッセージ`;

  GmailApp.sendEmail(mailTo, subject, body, {
    name: 'Slack Email Forwarder',
  });

  // メール送信に成功した後だけ更新する
  const newestTs = messages[messages.length - 1].ts;
  props.setProperty('LAST_TS', newestTs);

  console.log(
    `${messages.length}件をメール送信しました。LAST_TS=${newestTs}`
  );
}


/**
 * 初回実行用。
 *
 * 現在時刻までの通常投稿・返信を「処理済み」として記録する。
 * これを最初に1回実行してから checkSlackMessages() を使う。
 */
function initializeLastTs() {
  const props = PropertiesService.getScriptProperties();

  const token = requireProperty_(props, 'SLACK_BOT_TOKEN');
  const channelId = requireProperty_(props, 'SLACK_CHANNEL_ID');

  const url =
    'https://slack.com/api/conversations.history' +
    '?channel=' + encodeURIComponent(channelId) +
    '&limit=1';

  const latestTs = (Date.now() / 1000).toFixed(6);
  // アクセスを確認してから初期化する。空のチャンネルでも可。
  callSlackApi_(url, token);

  props.setProperty('LAST_TS', latestTs);

  console.log(
    `初期化しました。LAST_TS=${latestTs}`
  );
}


/**
 * デバッグ用。
 * 現在保存されているLAST_TSを表示する。
 */
function showLastTs() {
  const props = PropertiesService.getScriptProperties();

  console.log(
    'LAST_TS=' + (props.getProperty('LAST_TS') || '(未設定)')
  );
}


/**
 * デバッグ用。
 * LAST_TSを削除する。
 *
 * 注意:
 * 次回checkSlackMessages()実行時に過去メッセージも取得対象になる。
 */
function clearLastTs() {
  const props = PropertiesService.getScriptProperties();

  props.deleteProperty('LAST_TS');

  console.log('LAST_TSを削除しました。');
}


/**
 * 古い親投稿への新しい返信も検出するため、アクセス可能な履歴を全ページ確認する。
 * 途中で失敗した場合は送信・LAST_TS更新を行わない。
 */
function fetchSlackMessages_(token, channelId, lastTs, threadToken) {
  const scan = { startedAt: Date.now(), requests: 0 };
  const latest = (scan.startedAt / 1000).toFixed(6);
  const messages = new Map();
  const threads = new Set();
  readSlackPages_('conversations.history', token, {
    channel: channelId, latest: latest, inclusive: 'false', limit: '100',
  }, scan, function(page) {
    page.forEach(function(message) {
      if (isWithinWindow_(message.ts, lastTs, latest)) messages.set(message.ts, message);
      const rootTs = message.thread_ts || message.ts;
      if (message.reply_count > 0 && rootTs === message.ts &&
          (!message.latest_reply || compareSlackTs_(message.latest_reply, lastTs) > 0)) {
        threads.add(rootTs);
      }
    });
  });
  threads.forEach(function(rootTs) {
    readSlackPages_('conversations.replies', threadToken || token, {
      channel: channelId, ts: rootTs, oldest: lastTs,
      latest: latest, inclusive: 'false', limit: '100',
    }, scan, function(page) {
      page.forEach(function(message) {
        if (message.ts !== rootTs && isWithinWindow_(message.ts, lastTs, latest)) {
          messages.set(message.ts, Object.assign({}, message, { thread_ts: rootTs }));
        }
      });
    });
  });
  ensureScanBudget_(scan);
  return Array.from(messages.values()).sort(function(a, b) {
    return compareSlackTs_(a.ts, b.ts);
  });
}

function isWithinWindow_(ts, oldest, latest) {
  return compareSlackTs_(ts, oldest) > 0 && compareSlackTs_(ts, latest) < 0;
}

// Slackのタイムスタンプをマイクロ秒精度で比較する。
function compareSlackTs_(left, right) {
  const a = String(left).split('.');
  const b = String(right).split('.');
  const seconds = Number(a[0]) - Number(b[0]);
  if (seconds !== 0) return seconds;
  return Number((a[1] || '').padEnd(6, '0')) - Number((b[1] || '').padEnd(6, '0'));
}

function ensureScanBudget_(scan) {
  if (Date.now() - scan.startedAt >= MAX_SCAN_MILLISECONDS) {
    throw new Error('履歴の確認が制限時間を超えました。送信とLAST_TS更新は行いません。');
  }
}

function readSlackPages_(method, token, params, scan, onPage) {
  let cursor = '';
  const seen = new Set();
  do {
    ensureScanBudget_(scan);
    if (scan.requests >= MAX_SCAN_REQUESTS) {
      throw new Error('履歴取得の上限200リクエストに達しました。送信とLAST_TS更新は行いません。');
    }
    const query = Object.assign({}, params);
    if (cursor) query.cursor = cursor;
    const url = 'https://slack.com/api/' + method + '?' + Object.keys(query)
      .map(function(key) { return encodeURIComponent(key) + '=' + encodeURIComponent(query[key]); })
      .join('&');
    scan.requests += 1;
    let data;
    try {
      data = callSlackApi_(url, token);
    } catch (error) {
      if (method === 'conversations.replies') {
        throw new Error('スレッド取得に失敗しました。Botの権限で取得できない場合は、' +
          '必要な履歴権限を持つSLACK_USER_TOKENを設定してください。' + error.message);
      }
      throw error;
    }
    if (!Array.isArray(data.messages)) throw new Error('Slackの応答にmessagesがありません。');
    onPage(data.messages);
    cursor = ((data.response_metadata || {}).next_cursor || '').trim();
    if (data.has_more && !cursor) {
      throw new Error('Slackが続きのカーソルを返しませんでした。LAST_TSは更新しません。');
    }
    if (cursor && seen.has(cursor)) throw new Error('Slackのページカーソルが重複しています。');
    if (cursor) seen.add(cursor);
  } while (cursor);
}


/**
 * Slack APIを呼び出す。
 */
function callSlackApi_(url, token) {
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      Authorization: 'Bearer ' + token,
    },
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  const text = response.getContentText();

  let data;

  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `Slack APIのJSON解析に失敗しました。HTTP ${status}: ${text}`
    );
  }

  if (status < 200 || status >= 300) {
    throw new Error(
      `Slack API HTTP error ${status}: ${text}`
    );
  }

  if (!data.ok) {
    throw new Error(
      `Slack API error: ${data.error || 'unknown_error'}`
    );
  }

  return data;
}


/**
 * Slack User IDから表示名を取得する。
 *
 * API呼び出し回数を減らすため、
 * 一度取得した名前はスクリプトプロパティへキャッシュする。
 */
function getSlackUserName_(token, userId) {
  const props = PropertiesService.getScriptProperties();

  const cacheKey = `SLACK_USER_${userId}`;
  const cached = props.getProperty(cacheKey);

  if (cached) {
    return cached;
  }

  const url =
    'https://slack.com/api/users.info' +
    '?user=' + encodeURIComponent(userId);

  const data = callSlackApi_(url, token);

  const user = data.user || {};
  const profile = user.profile || {};

  const name =
    profile.display_name ||
    profile.real_name ||
    user.real_name ||
    user.name ||
    userId;

  props.setProperty(cacheKey, name);

  return name;
}


/**
 * Slack本文内のユーザーメンション
 *
 * <@U0123456789>
 *
 * を
 *
 * @表示名
 *
 * に変換する。
 */
function replaceSlackMentions_(token, text) {
  return text.replace(/<@([A-Z0-9]+)>/g, function(_, userId) {
    try {
      return '@' + getSlackUserName_(token, userId);
    } catch (e) {
      // 名前取得に失敗した場合は元の表記を残す
      console.warn(
        `ユーザー名取得に失敗しました: ${userId}: ${e.message}`
      );

      return `<@${userId}>`;
    }
  });
}


/**
 * メール本文用に1メッセージを整形する。
 */
function formatMessage_(token, message, index) {
  const timestamp = Number(message.ts) * 1000;

  const date = Utilities.formatDate(
    new Date(timestamp),
    TIME_ZONE,
    'yyyy-MM-dd HH:mm:ss'
  );

  let text = message.text || '';

  text = replaceSlackMentions_(token, text);

  const lines = [
    `#${index}`,
    `日時: ${date}`,
  ];

  if (message.user) {
    let userName;

    try {
      userName = getSlackUserName_(token, message.user);
    } catch (e) {
      console.warn(
        `投稿者名取得に失敗しました: ${message.user}: ${e.message}`
      );

      userName = message.user;
    }

    lines.push(`投稿者: ${userName}`);
  }

  if (message.thread_ts && message.thread_ts !== message.ts) {
    lines.push('種別: スレッド返信');
    lines.push('親投稿日時: ' + Utilities.formatDate(
      new Date(Number(message.thread_ts) * 1000), TIME_ZONE, 'yyyy-MM-dd HH:mm:ss'
    ));
  }
  lines.push('');
  lines.push(text);

  return lines.join('\n');
}


/**
 * 必須スクリプトプロパティを取得する。
 */
function requireProperty_(props, key) {
  const value = props.getProperty(key);

  if (!value) {
    throw new Error(
      `スクリプトプロパティ "${key}" が設定されていません。`
    );
  }

  return value;
}