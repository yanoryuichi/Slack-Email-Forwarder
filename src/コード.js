/**
 * Slackの特定チャンネルの新着メッセージを取得して、
 * Gmailを使って、指定のメールアドレスへまとめて送信する。
 *
 * 必須スクリプトプロパティ:
 * - SLACK_BOT_TOKEN
 * - SLACK_CHANNEL_ID
 * - MAIL_TO
 *
 * 自動生成:
 * - LAST_TS
 * - SLACK_USER_<USER_ID>
 */

const TIME_ZONE = 'Asia/Tokyo';

/**
 * Slack新着メッセージを確認してメール送信する。
 * 時間主導トリガーから定期実行する想定。
 */
function checkSlackMessages() {
  const props = PropertiesService.getScriptProperties();

  const token = requireProperty_(props, 'SLACK_BOT_TOKEN');
  const channelId = requireProperty_(props, 'SLACK_CHANNEL_ID');
  const mailTo = requireProperty_(props, 'MAIL_TO');

  const lastTs = props.getProperty('LAST_TS') || '0';

  const messages = fetchSlackMessages_(token, channelId, lastTs);

  if (messages.length === 0) {
    console.log('新着メッセージはありません。');
    return;
  }

  // conversations.history は新しい順なので古い順にする
  messages.reverse();

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
 * 現在の最新メッセージを「処理済み」として記録する。
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

  const data = callSlackApi_(url, token);

  if (!data.messages || data.messages.length === 0) {
    throw new Error(
      'Slackチャンネルにメッセージがありません。'
    );
  }

  const latestTs = data.messages[0].ts;

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
 * Slackから前回以降のメッセージを取得する。
 */
function fetchSlackMessages_(token, channelId, lastTs) {
  const params = [
    'channel=' + encodeURIComponent(channelId),
    'oldest=' + encodeURIComponent(lastTs),
    'inclusive=false',
    'limit=100',
  ];

  const url =
    'https://slack.com/api/conversations.history?' +
    params.join('&');

  const data = callSlackApi_(url, token);

  return data.messages || [];
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