# Slack Email Forwarder

指定したSlackチャンネルの新着投稿とスレッド返信をまとめて、指定のメールアドレスへ転送するアプリです。
Slackを開いていないときも、投稿内容をメールで確認できます。
Google Apps Script（GAS）が5分間隔でSlack APIから投稿を取得し、投稿者名・日時・本文を1通のメールにまとめて送信します。
PCを起動しておく必要はありません。
複数の新着投稿は1通にまとめ、メール送信が成功した後にだけ `LAST_TS` を更新します。

送信元はGASを実行するGoogleアカウント、送信先は設定したメールアドレスです。

## 導入手順

### 0. 導入前に用意するもの

- Gmailを利用できるGoogleアカウント。
- Slackワークスペースと、監視する公開または非公開チャンネル。
- そのワークスペースにカスタムアプリをインストールできる権限。承認制の場合は管理者への申請が必要です。
- このリポジトリの [GASソース](src/コード.js) と [マニフェスト](src/appsscript.json)。

内部用カスタムSlack Appとして利用する想定です。履歴・返信は1ページ100件で取得します。
古い投稿に付いた新しい返信も見つけるため、アクセス可能なチャンネル履歴を毎回全ページ確認します。
履歴が多いチャンネルではAPI呼び出しが増え、レート制限やGASの実行時間制限に達する可能性があります。
4分または200リクエストの走査上限に達した場合は、途中結果を送信せず処理位置も更新しません。
この上限に毎回達する規模では、イベント受信方式などへの設計変更が必要です。
Slackの保存期間・アクセス権限で参照できない親投稿の返信は取得できません。

導入は「Slack App作成・権限設定 → ワークスペースへインストール → チャンネルへ追加 → GAS設置 → 初期化・テスト → トリガー設定」の順に進めます。

### 1. Slack APIでアプリを作成する

1. [Slack APIのアプリ管理画面](https://api.slack.com/apps)を開きます。
2. **Create New App → From scratch** を選びます。
3. App Nameに `Slack Email Forwarder` と入力します。
4. アプリを利用するワークスペースを選び、**Create App** を押します。

このアプリはGASからSlackの履歴を定期取得します。Event Subscriptions、Incoming Webhooks、Slash Commands、Socket Modeの設定は不要です。

### 2. Slack Appの権限を設定する

作成したアプリの **OAuth & Permissions → Scopes → Bot Token Scopes** で、次の権限を追加します。
User Token Scopesではなく、Bot Token Scopesに追加してください。

| 権限 | 用途 | 追加する場合 |
| --- | --- | --- |
| `users:read` | 投稿者と本文中のメンションの表示名を取得 | 必須 |
| `channels:history` | 公開チャンネルの投稿を取得 | 公開チャンネルを監視する場合 |
| `channels:read` | 公開チャンネルの基本情報を取得 | 公開チャンネル向けの設定に追加（現行コードでは未使用） |
| `groups:history` | 非公開チャンネルの投稿を取得 | 非公開チャンネルを監視する場合 |

公開チャンネルでは `channels:history`、`channels:read`、`users:read` を設定します。
現行コードの履歴取得と表示名取得に必須なのは `channels:history` と `users:read` です。
非公開チャンネルを監視する場合は `groups:history` も追加します。
チャンネルへ投稿する機能はないため、`chat:write` は不要です。

### 3. Slackワークスペースへインストールする

1. **OAuth & Permissions** の **Install to Workspace** を押します。
2. インストール先と要求される権限を確認し、**Allow（許可）** を押します。
3. OAuth & Permissionsへ戻り、**Bot User OAuth Token** を確認します。
4. このトークンは後のGAS設定で使用します。ソースコードやREADMEには貼り付けないでください。

使用するのは `xoxb-` で始まるBot User OAuth Tokenです。App-Level Token、Client Secret、Signing Secretではありません。
権限を後から追加した場合は **Reinstall to Workspace** を実行して反映します。

この手順はワークスペースへのインストールです。監視するチャンネルへの追加は次の手順で行います。
[Slack公式のアプリ作成・インストール手順](https://docs.slack.dev/app-management/quickstart-app-settings/)

### 4. Slackで監視対象チャンネルにアプリを追加する

1. Slackで監視したいチャンネルを開きます。
2. 上部のチャンネル名をクリックし、**エージェントとアプリ（Agents & apps）** または **インテグレーション** を開きます。名称は画面によって異なります。
3. アプリの追加から `Slack Email Forwarder` を選び、チャンネルに追加します。
4. チャンネルの詳細画面でチャンネルIDを確認して控えます。GASには `#general` のような名前ではなく、IDを設定します。

チャンネルIDは、ブラウザーで開いたチャンネルのURLが `https://app.slack.com/client/<ワークスペースID>/<チャンネルID>` の形式なら、その最後の部分でも確認できます。

非公開チャンネルでもアプリの追加が必要です。Bot Tokenに履歴取得の権限があっても、Botが参加していないチャンネルの投稿は取得できません。
[Slack公式のチャンネルへのアプリ追加案内](https://slack.com/help/articles/360001537467-Guide-to-apps-in-Slack)

### 5. GASプロジェクトを作成してコードを設置する

1. メール送信元として使うGoogleアカウントで [Google Apps Script](https://script.google.com/) を開きます。
2. **新しいプロジェクト** を作成し、名前を `Slack Email Forwarder` にします。
3. エディタの既定の `コード.gs`（または `Code.gs`）の内容をすべて削除し、[src/コード.js](src/コード.js) の内容を貼り付けて保存します。ローカルの拡張子が `.js` でも、GAS上では `.gs` のファイルに貼り付けて構いません。
4. 左側の **プロジェクトの設定** を開き、**「appsscript.json」マニフェスト ファイルをエディタで表示する** を有効にします。
5. エディタへ戻り、`appsscript.json` の内容を [src/appsscript.json](src/appsscript.json) と同じ内容に置き換えて保存します。

マニフェストでは実行環境をV8、タイムゾーンを `Asia/Tokyo` に設定しています。
この方式ではWebアプリとしてのデプロイや公開URLは不要です。
[Google公式のプロジェクト作成案内](https://developers.google.com/apps-script/guides/standalone)・[マニフェストの表示方法](https://developers.google.com/apps-script/concepts/manifests)

### 6. GASのスクリプトプロパティを設定する

GASの **プロジェクトの設定 → スクリプト プロパティ** で必須の3項目を追加し、保存します。`SLACK_USER_TOKEN` は必要な場合だけ追加します。

| プロパティ名 | 設定する値 |
| --- | --- |
| `SLACK_BOT_TOKEN` | 手順3で取得したBot User OAuth Token |
| `SLACK_CHANNEL_ID` | 手順4で確認した監視対象のチャンネルID |
| `MAIL_TO` | メールを受け取るアドレス |
| `SLACK_USER_TOKEN` | 任意。Bot Tokenでスレッドを取得できない場合のUser OAuth Token |

値の前後に引用符や余計な空白を入れないでください。
実値はGAS側で管理し、Gitには保存しません。
Slack Bot Token、Client Secret、Signing Secret、実際のメールアドレスやSlack IDをソースや設定例へ書き込まないでください。
実Script IDを含む `.clasp.json` と認証情報 `.clasprc.json` もGit管理対象外です。
`.gitignore` はファイル内の秘密情報までは検査しないため、コミット前に差分を確認してください。

次のプロパティはコードが自動生成するため、手動で追加する必要はありません。

| プロパティ名 | 用途 |
| --- | --- |
| `LAST_TS` | 最後に処理した投稿のタイムスタンプ |
| `SLACK_USER_<USER_ID>` | 投稿者やメンションの表示名のキャッシュ |

スレッド取得には [conversations.replies](https://docs.slack.dev/reference/methods/conversations.replies/) を使用します。
Bot Tokenで権限エラーになる場合は、Slack Appの **OAuth & Permissions → User Token Scopes** に
公開チャンネル用の `channels:history`、非公開チャンネル用の `groups:history` を必要に応じて追加し、
**Reinstall to Workspace** 後の **User OAuth Token** を `SLACK_USER_TOKEN` に設定します。
User Tokenの所有者は監視チャンネルにアクセスできる必要があります。このトークンもGitには保存しません。
通常投稿と表示名の取得には引き続き `SLACK_BOT_TOKEN` を使用します。

[Google公式のスクリプトプロパティ設定案内](https://developers.google.com/apps-script/guides/properties)

### 7. 初期化と送信テストを行う

トリガーを作成する前に、手動実行で設定を確認します。

1. Slack Appが監視チャンネルへ追加済みであることを確認します。空のチャンネルでも初期化できます。
2. GASエディタ上部の関数選択で **initializeLastTs** を選び、**実行** を押します。
3. 初回のアクセス許可画面では、送信元のGoogleアカウントを選び、要求される権限を確認して許可します。Gmail操作と外部サービスへの接続に使います。組織のポリシーでブロックされる場合は管理者に確認してください。
4. 実行ログに「初期化しました」と表示されることを確認します。この時点までの通常投稿・返信が処理済みになります。
5. Slackの監視チャンネルに、新しいテスト投稿を1件送ります。表示名の変換を確認するなら、本文にユーザーメンションを含めます。
6. GASで **checkSlackMessages** を選択して実行します。追加の認可を求められた場合は確認して許可します。
7. `MAIL_TO` に設定した宛先で、件名が `[Slack] 1件の新着メッセージ` のメールを確認します。投稿者名・日本時間の日時・本文が表示されているか確認してください。
8. 古い投稿のスレッドに新しい返信を追加して再実行し、メールに「種別: スレッド返信」と親投稿日時が表示されることを確認します。チャンネルにも表示した返信は1件として扱います。
9. 新しい投稿をせずにもう一度実行し、「新着メッセージはありません」と表示され、同じメールが再送されないことを確認します。

`initializeLastTs` は新規導入時に一度だけ実行します。運用中に再実行すると未転送の投稿まで処理済みになる可能性があります。
既存のGASプロジェクトを継続利用する場合は、保存されている `LAST_TS` を維持してください。
更新後はこの時刻より新しい返信が対象です。以前の実装で未転送だった、この時刻以前の返信は再取得しません。
取得失敗・メール送信失敗時は処理位置を進めません。同時実行はロックで抑止しますが、
送信成功直後に処理位置の保存が失敗した場合は次回に再送される可能性があります。

### 8. 5分間隔のトリガーを設定する

送信テストに成功したら、GASで定期実行を設定します。

1. 左側の時計アイコン **トリガー** を開きます。
2. **トリガーを追加** を押します。
3. 以下のように設定して保存します。

| 項目 | 設定 |
| --- | --- |
| 実行する関数 | `checkSlackMessages` |
| 実行するデプロイ | `Head` |
| イベントのソース | 時間主導型 |
| 時間ベースのトリガーのタイプ | 分ベースのタイマー |
| 時間の間隔 | 5分おき |

同じ関数のトリガーは1つだけにします。`initializeLastTs` はトリガーに登録しません。
トリガーは作成したGoogleアカウントの権限で実行され、そのアカウントからメールが送られます。
設定後にSlackへ新しい投稿を送り、次の定期実行でメールが届くことを確認してください。
実行結果やエラーはGAS左側の **実行数** で確認できます。
[Google公式の時間主導トリガーの説明](https://developers.google.com/apps-script/guides/triggers/installable)

これでSlackへのアプリ導入と自動転送の設定は完了です。転送を停止する場合は、このトリガーを削除します。
