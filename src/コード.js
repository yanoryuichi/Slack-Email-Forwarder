/**
 * Slackの特定チャンネルの新着メッセージを取得し、
 * スレッドごとにまとめてGmailで送信する。
 *
 * 必須スクリプトプロパティ:
 * - SLACK_BOT_TOKEN
 * - SLACK_CHANNEL_ID
 * - MAIL_TO
 *
 * 任意:
 * - SLACK_USER_TOKEN（Botでスレッド取得できない場合）
 *
 * 自動生成するスクリプトプロパティ:
 * - LAST_TS
 * - SLACK_USER_<USER_ID>
 *
 * 親投稿:
 * - 実行中の変数 → GASキャッシュ → Slack API の順で取得。
 * - キャッシュ保存期間は6時間。
 * - キャッシュは期限前に消える場合がある。
 * - 送信済みの親投稿は参考として引用形式で再掲載する。
 * - 再掲載した親投稿は新着件数に含めない。
 *
 * メール本文:
 * - 新着親投稿: ## 名前（日時）
 * - 送信済み親投稿: > ## 名前（日時）
 *   本文も空行を含め、全行を引用形式にする。
 * - 新着返信: ### 名前（日時）
 * - スレッド間は「---」で区切る。
 *
 * チャンネル名の取得に必要なBot Token Scope:
 * - 公開チャンネル: channels:read
 * - 非公開チャンネル: groups:read
 */

const TIME_ZONE = 'Asia/Tokyo';

const MAX_SCAN_MILLISECONDS = 4 * 60 * 1000;
const MAX_SCAN_REQUESTS = 200;

// 親投稿のキャッシュ保存期間: 6時間
const PARENT_CACHE_SECONDS = 6 * 60 * 60;

/**
 * 時間主導トリガーから定期実行する。
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

/**
 * 新着メッセージを取得してメール送信する。
 */
function forwardSlackMessages_() {
  const props = PropertiesService.getScriptProperties();

  const token = requireProperty_(props, 'SLACK_BOT_TOKEN');
  const channelId = requireProperty_(props, 'SLACK_CHANNEL_ID');
  const mailTo = requireProperty_(props, 'MAIL_TO');

  const lastTs = props.getProperty('LAST_TS') || '0';
  const threadToken = props.getProperty('SLACK_USER_TOKEN') || token;

  const result = fetchSlackMessages_(
    token,
    channelId,
    lastTs,
    threadToken
  );

  // 新着だけの配列。投稿日時の古い順に整列済み。
  const messages = result.messages;

  if (messages.length === 0) {
    console.log('新着メッセージはありません。');
    return;
  }

  const source = getSlackSourceInfo_(token, channelId);
  const threads = groupMessagesByThread_(messages, result.parents);

  const header = [
    '---',
    'name: ' + JSON.stringify('Slack転送メール'),
    'workspace: ' + JSON.stringify(source.workspaceName),
    'channel: ' + JSON.stringify(source.channelName),
    '---',
  ].join('\n');

  const threadBody = threads
    .map(function(thread) {
      return formatThread_(token, thread);
    })
    .join('\n\n---\n\n');

  const body = header + '\n\n' + threadBody;

  const subject =
    `[Slack] ${source.workspaceName} / #${source.channelName}` +
    `：${messages.length}件の新着メッセージ`;

  GmailApp.sendEmail(mailTo, subject, body, {
    name: 'Slack Email Forwarder',
  });

  // スレッド表示順ではなく、新着全体の最新日時を保存する。
  // 引用として再掲載した親投稿は対象に含めない。
  const newestTs = messages[messages.length - 1].ts;

  // メール送信に成功した後だけ更新する。
  props.setProperty('LAST_TS', newestTs);

  console.log(
    `${messages.length}件をメール送信しました。LAST_TS=${newestTs}`
  );
}

/**
 * ワークスペース名とチャンネル名を取得する。
 * 名前変更が反映されるように永続キャッシュしない。
 */
function getSlackSourceInfo_(token, channelId) {
  const auth = callSlackApi_(
    'https://slack.com/api/auth.test',
    token,
    'post'
  );

  const channelData = callSlackApi_(
    'https://slack.com/api/conversations.info' +
    '?channel=' + encodeURIComponent(channelId),
    token
  );

  const channel = channelData.channel || {};

  return {
    workspaceName: auth.team || auth.team_id || '(不明)',
    channelName: channel.name || channelId,
  };
}

/**
 * 初回実行用。
 *
 * 現在時刻までの通常投稿・返信を処理済みとして記録する。
 * 初めて使用する場合に1回実行する。
 *
 * すでに運用中の場合は再実行不要。
 */
function initializeLastTs() {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(1000)) {
    throw new Error(
      'ほかの処理が実行中です。後でもう一度実行してください。'
    );
  }

  try {
    const props = PropertiesService.getScriptProperties();

    const token = requireProperty_(props, 'SLACK_BOT_TOKEN');
    const channelId = requireProperty_(props, 'SLACK_CHANNEL_ID');

    const latestTs = (Date.now() / 1000).toFixed(6);

    // アクセスを確認してから初期化する。空のチャンネルでも可。
    callSlackApi_(
      'https://slack.com/api/conversations.history' +
      '?channel=' + encodeURIComponent(channelId) +
      '&limit=1',
      token
    );

    props.setProperty('LAST_TS', latestTs);

    console.log(`初期化しました。LAST_TS=${latestTs}`);
  } finally {
    lock.releaseLock();
  }
}

/**
 * 現在保存されているLAST_TSを表示する。
 */
function showLastTs() {
  const props = PropertiesService.getScriptProperties();

  console.log(
    'LAST_TS=' + (props.getProperty('LAST_TS') || '(未設定)')
  );
}

/**
 * LAST_TSを削除する。
 *
 * 注意:
 * 次回実行時に過去メッセージも取得対象になる。
 */
function clearLastTs() {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(1000)) {
    throw new Error(
      'ほかの処理が実行中です。後でもう一度実行してください。'
    );
  }

  try {
    const props = PropertiesService.getScriptProperties();

    props.deleteProperty('LAST_TS');

    console.log('LAST_TSを削除しました。');
  } finally {
    lock.releaseLock();
  }
}

/**
 * 新着投稿・新着返信と、参考表示用の親投稿を取得する。
 *
 * 古いスレッドへの新着返信を検出するため、
 * チャンネル履歴の全ページ確認は維持する。
 *
 * 戻り値:
 * - messages: 新着だけ。日時の古い順。
 * - parents: 親投稿のMap。送信済みの親投稿も含む。
 */
function fetchSlackMessages_(token, channelId, lastTs, threadToken) {
  const scan = {
    startedAt: Date.now(),
    requests: 0,
  };

  const latest = (scan.startedAt / 1000).toFixed(6);

  const messages = new Map();
  const parents = new Map();
  const threadsToFetch = new Set();

  readSlackPages_(
    'conversations.history',
    token,
    {
      channel: channelId,
      latest: latest,
      inclusive: 'false',
      limit: '100',
    },
    scan,
    function(page) {
      page.forEach(function(message) {
        const rootTs = message.thread_ts || message.ts;

        // 今回の履歴取得で得られた親投稿をメモリに保持する。
        if (rootTs === message.ts) {
          parents.set(rootTs, message);
        }

        if (isWithinWindow_(message.ts, lastTs, latest)) {
          messages.set(message.ts, message);
        }

        if (
          message.reply_count > 0 &&
          rootTs === message.ts &&
          (
            !message.latest_reply ||
            compareSlackTs_(message.latest_reply, lastTs) > 0
          )
        ) {
          threadsToFetch.add(rootTs);
        }

        // チャンネルにも表示された新着返信などへの対応。
        if (
          rootTs !== message.ts &&
          isWithinWindow_(message.ts, lastTs, latest)
        ) {
          threadsToFetch.add(rootTs);
        }
      });
    }
  );

  threadsToFetch.forEach(function(rootTs) {
    readSlackPages_(
      'conversations.replies',
      threadToken || token,
      {
        channel: channelId,
        ts: rootTs,
        oldest: lastTs,
        latest: latest,
        inclusive: 'false',
        limit: '100',
      },
      scan,
      function(page) {
        page.forEach(function(message) {
          if (message.ts === rootTs) {
            parents.set(rootTs, message);
            return;
          }

          if (isWithinWindow_(message.ts, lastTs, latest)) {
            messages.set(
              message.ts,
              Object.assign({}, message, {
                thread_ts: rootTs,
              })
            );
          }
        });
      }
    );
  });

  // 新着があるスレッドの親投稿だけを解決する。
  const neededRoots = new Set();

  messages.forEach(function(message) {
    neededRoots.add(message.thread_ts || message.ts);
  });

  neededRoots.forEach(function(rootTs) {
    getParentMessage_(
      threadToken || token,
      channelId,
      rootTs,
      parents,
      scan
    );
  });

  ensureScanBudget_(scan);

  return {
    messages: Array.from(messages.values()).sort(function(a, b) {
      return compareSlackTs_(a.ts, b.ts);
    }),
    parents: parents,
  };
}

/**
 * 親投稿を取得する。
 *
 * 実行中の変数 → GASキャッシュ → Slack API の順で確認する。
 *
 * 追加の親投稿取得だけが失敗した場合はnullを返す。
 * 履歴取得の制限時間・リクエスト上限を超えた場合は中止する。
 */
function getParentMessage_(token, channelId, rootTs, parents, scan) {
  ensureScanBudget_(scan);

  // 1. 実行中の変数を確認する。
  if (parents.has(rootTs)) {
    const parent = parents.get(rootTs);

    // 今回取得できた最新の内容でキャッシュを更新する。
    cacheParentMessage_(channelId, parent);

    return parent;
  }

  const cacheKey = getParentCacheKey_(channelId, rootTs);

  // 2. GASのキャッシュを確認する。
  try {
    const cached = CacheService.getScriptCache().get(cacheKey);

    if (cached) {
      const parent = JSON.parse(cached);

      if (
        parent &&
        parent.ts === rootTs &&
        typeof parent.text === 'string'
      ) {
        parents.set(rootTs, parent);

        console.log(
          `親投稿をキャッシュから取得しました: ${rootTs}`
        );

        return parent;
      }
    }
  } catch (e) {
    // キャッシュ障害やJSON解析失敗でもAPI取得へ進む。
    console.warn(
      `親投稿キャッシュの読み取りに失敗しました: ${rootTs}: ${e.message}`
    );
  }

  // 3. Slack APIから親投稿を取得する。
  ensureScanBudget_(scan);

  if (scan.requests >= MAX_SCAN_REQUESTS) {
    throw new Error(
      `履歴取得の上限${MAX_SCAN_REQUESTS}リクエストに達しました。` +
      '送信とLAST_TS更新は行いません。'
    );
  }

  scan.requests += 1;

  let parent = null;

  try {
    // oldestを指定しないことで、過去の親投稿も取得対象にする。
    const data = callSlackApi_(
      'https://slack.com/api/conversations.replies' +
      '?channel=' + encodeURIComponent(channelId) +
      '&ts=' + encodeURIComponent(rootTs) +
      '&limit=1',
      token
    );

    if (!Array.isArray(data.messages)) {
      throw new Error('Slackの応答にmessagesがありません。');
    }

    parent = data.messages.find(function(message) {
      return message.ts === rootTs;
    }) || null;

    if (!parent) {
      console.warn(
        `親投稿を取得できませんでした: ${rootTs}`
      );
    }
  } catch (e) {
    // 参考表示用の親投稿を取得できなくても、新着返信は送信する。
    console.warn(
      `親投稿の追加取得に失敗しました: ${rootTs}: ${e.message}`
    );
  }

  ensureScanBudget_(scan);

  if (!parent) {
    // 取得失敗はキャッシュせず、次回また取得を試みる。
    return null;
  }

  parents.set(rootTs, parent);
  cacheParentMessage_(channelId, parent);

  console.log(
    `親投稿をSlack APIから追加取得しました: ${rootTs}`
  );

  return parent;
}

/**
 * 親投稿をGASのキャッシュへ保存する。
 *
 * 表示に必要な項目だけ保存する。
 * キャッシュへの保存失敗でメール送信を止めない。
 */
function cacheParentMessage_(channelId, message) {
  try {
    const parent = {
      ts: message.ts,
      text: message.text || '',
      user: message.user || '',
      username: message.username || '',
      bot_id: message.bot_id || '',
      bot_profile: {
        name: (message.bot_profile || {}).name || '',
      },
    };

    const value = JSON.stringify(parent);

    // 1キーあたり100KBの制限に対して余裕を持たせる。
    const byteLength = Utilities.newBlob(value).getBytes().length;

    if (byteLength > 90 * 1024) {
      console.warn(
        `親投稿が大きいためキャッシュを省略しました: ${message.ts}`
      );

      return;
    }

    CacheService.getScriptCache().put(
      getParentCacheKey_(channelId, message.ts),
      value,
      PARENT_CACHE_SECONDS
    );
  } catch (e) {
    console.warn(
      `親投稿のキャッシュ保存に失敗しました: ${message.ts}: ${e.message}`
    );
  }
}

/**
 * チャンネルIDと親投稿のtsからキャッシュキーを作成する。
 */
function getParentCacheKey_(channelId, rootTs) {
  return `SLACK_PARENT_V1_${channelId}_${rootTs}`;
}

/**
 * 新着をスレッドごとにまとめる。
 *
 * スレッド間:
 *   各スレッドの今回最初の新着日時が古い順。
 *
 * スレッド内:
 *   親投稿を先頭に表示し、新着返信を古い順に表示。
 *
 * 返信のない通常投稿も1つのグループとして扱う。
 */
function groupMessagesByThread_(messages, parents) {
  const groups = new Map();

  // messagesは古い順なので、追加順がスレッドの表示順になる。
  messages.forEach(function(message) {
    const rootTs = message.thread_ts || message.ts;

    if (!groups.has(rootTs)) {
      groups.set(rootTs, {
        rootTs: rootTs,
        parent: parents.get(rootTs) || null,
        parentIsNew: false,
        replies: [],
      });
    }

    const group = groups.get(rootTs);

    if (message.ts === rootTs) {
      group.parent = message;
      group.parentIsNew = true;
    } else {
      group.replies.push(message);
    }
  });

  return Array.from(groups.values());
}

/**
 * 1スレッドをMarkdown形式に整形する。
 *
 * 新着親投稿は通常表示。
 * 送信済み親投稿は、見出し・空行・本文をすべて引用にする。
 */
function formatThread_(token, thread) {
  const sections = [];

  if (thread.parent) {
    let parentText = formatMessage_(
      token,
      thread.parent,
      '##'
    );

    if (!thread.parentIsNew) {
      parentText = quoteText_(parentText);
    }

    sections.push(parentText);
  } else {
    // 親投稿が取得できない場合も、スレッドの開始を示す。
    sections.push(
      quoteText_(
        `## 親投稿不明（${formatSlackDate_(thread.rootTs)}）\n\n` +
        '親投稿を取得できませんでした。'
      )
    );
  }

  thread.replies.forEach(function(message) {
    sections.push(
      formatMessage_(token, message, '###')
    );
  });

  return sections.join('\n\n');
}

/**
 * 全行をMarkdownの引用形式にする。
 * 空行は「>」、それ以外は「> 本文」にする。
 */
function quoteText_(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(function(line) {
      return line === '' ? '>' : '> ' + line;
    })
    .join('\n');
}

/**
 * 1メッセージをMarkdown形式に整形する。
 *
 * 親投稿: ## 名前（日時）
 * 返信:   ### 名前（日時）
 */
function formatMessage_(token, message, heading) {
  const name = getMessageAuthorName_(token, message);

  // 見出しが複数行にならないようにする。
  const headingName = String(name)
    .replace(/[\r\n]+/g, ' ')
    .trim();

  const date = formatSlackDate_(message.ts);

  const text = replaceSlackMentions_(
    token,
    message.text || ''
  ).replace(/\r\n?/g, '\n');

  return [
    `${heading} ${headingName}（${date}）`,
    text,
  ].join('\n\n');
}

/**
 * メッセージの投稿者名を取得する。
 */
function getMessageAuthorName_(token, message) {
  if (message.user) {
    try {
      return getSlackUserName_(token, message.user);
    } catch (e) {
      console.warn(
        `投稿者名取得に失敗しました: ${message.user}: ${e.message}`
      );

      return message.user;
    }
  }

  // Bot投稿などでuserがない場合。
  return (
    (message.bot_profile || {}).name ||
    message.username ||
    message.bot_id ||
    '投稿者不明'
  );
}

/**
 * Slackタイムスタンプを日本時間で整形する。
 */
function formatSlackDate_(ts) {
  return Utilities.formatDate(
    new Date(Number(ts) * 1000),
    TIME_ZONE,
    'yyyy-MM-dd HH:mm'
  );
}

/**
 * 指定の取得期間内か確認する。
 */
function isWithinWindow_(ts, oldest, latest) {
  return (
    compareSlackTs_(ts, oldest) > 0 &&
    compareSlackTs_(ts, latest) < 0
  );
}

/**
 * Slackのタイムスタンプをマイクロ秒精度で比較する。
 */
function compareSlackTs_(left, right) {
  const a = String(left).split('.');
  const b = String(right).split('.');

  const seconds = Number(a[0]) - Number(b[0]);

  if (seconds !== 0) return seconds;

  return (
    Number((a[1] || '').padEnd(6, '0')) -
    Number((b[1] || '').padEnd(6, '0'))
  );
}

/**
 * 履歴取得の制限時間を確認する。
 */
function ensureScanBudget_(scan) {
  if (Date.now() - scan.startedAt >= MAX_SCAN_MILLISECONDS) {
    throw new Error(
      '履歴の確認が制限時間を超えました。' +
      '送信とLAST_TS更新は行いません。'
    );
  }
}

/**
 * Slack APIのページを順番に取得する。
 *
 * 新着取得に失敗した場合は、メール送信とLAST_TS更新を中止する。
 */
function readSlackPages_(method, token, params, scan, onPage) {
  let cursor = '';
  const seen = new Set();

  do {
    ensureScanBudget_(scan);

    if (scan.requests >= MAX_SCAN_REQUESTS) {
      throw new Error(
        `履歴取得の上限${MAX_SCAN_REQUESTS}リクエストに達しました。` +
        '送信とLAST_TS更新は行いません。'
      );
    }

    const query = Object.assign({}, params);

    if (cursor) {
      query.cursor = cursor;
    }

    const url =
      'https://slack.com/api/' + method + '?' +
      Object.keys(query)
        .map(function(key) {
          return (
            encodeURIComponent(key) + '=' +
            encodeURIComponent(query[key])
          );
        })
        .join('&');

    scan.requests += 1;

    let data;

    try {
      data = callSlackApi_(url, token);
    } catch (error) {
      if (method === 'conversations.replies') {
        throw new Error(
          'スレッド取得に失敗しました。' +
          'Botの権限で取得できない場合は、' +
          '必要な履歴権限を持つSLACK_USER_TOKENを設定してください。' +
          error.message
        );
      }

      throw error;
    }

    if (!Array.isArray(data.messages)) {
      throw new Error('Slackの応答にmessagesがありません。');
    }

    onPage(data.messages);

    cursor = (
      (data.response_metadata || {}).next_cursor || ''
    ).trim();

    if (data.has_more && !cursor) {
      throw new Error(
        'Slackが続きのカーソルを返しませんでした。' +
        'LAST_TSは更新しません。'
      );
    }

    if (cursor && seen.has(cursor)) {
      throw new Error(
        'Slackのページカーソルが重複しています。'
      );
    }

    if (cursor) {
      seen.add(cursor);
    }
  } while (cursor);
}

/**
 * Slack APIを呼び出す。
 * methodを省略した場合はGET。
 */
function callSlackApi_(url, token, method) {
  const response = UrlFetchApp.fetch(url, {
    method: method || 'get',
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
 * 一度取得した名前はスクリプトプロパティへキャッシュする。
 */
function getSlackUserName_(token, userId) {
  const props = PropertiesService.getScriptProperties();

  const cacheKey = `SLACK_USER_${userId}`;
  const cached = props.getProperty(cacheKey);

  if (cached) {
    return cached;
  }

  const data = callSlackApi_(
    'https://slack.com/api/users.info' +
    '?user=' + encodeURIComponent(userId),
    token
  );

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
 * Slack本文内のユーザーメンションを表示名に変換する。
 *
 * 変換前: <@U0123456789>
 * 変換後: @表示名
 */
function replaceSlackMentions_(token, text) {
  return text.replace(/<@([A-Z0-9]+)>/g, function(_, userId) {
    try {
      return '@' + getSlackUserName_(token, userId);
    } catch (e) {
      // 名前取得に失敗した場合は元の表記を残す。
      console.warn(
        `ユーザー名取得に失敗しました: ${userId}: ${e.message}`
      );

      return `<@${userId}>`;
    }
  });
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