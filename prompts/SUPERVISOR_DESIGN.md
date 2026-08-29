# SUPERVISOR_DESIGN.md

# PromptDictionary Supervisor Design

## 1. 目的

PromptDictionary開発において、これまで人間とChatGPTが行っていた
「Qwenの作業確認・状況判断・追加調査・修正指示・完了判定」を
Supervisor AIによって自動化する。

最終的な開発ループは以下とする。

Human
  ↓
Task
  ↓
Controller
  ↓
Supervisor AI
  ↓
Qwen
  ↓
実作業
  ↓
Controllerによる状態取得
  ↓
Supervisor AI
  ↓
PASS / FIX / HUMAN_REQUIRED


## 2. 基本方針

### 2.1 Qwen

Qwenは実際の開発作業を担当する。

担当範囲:

- ソースコードの調査
- ソースコードの変更
- ファイルの作成・編集
- Build
- Test
- Git操作
- 作業結果の報告

QwenはSupervisorではない。

Qwen自身が「作業完了」と判断しても、
それを最終的な完了判定とはしない。


### 2.2 Supervisor AI

Supervisor AIは、Qwenの作業を監督する。

担当範囲:

- Taskの理解
- Qwenの作業結果の評価
- 実装内容の妥当性判断
- Build / Test結果の評価
- Git差分の評価
- 必要な追加調査の判断
- Qwenへの次の作業指示
- 作業完了の判断
- 人間による確認が必要かどうかの判断

Supervisor AIは単なるPASS/FIX判定器ではない。


### 2.3 Controller

ControllerはSupervisor AIとQwenを接続する
決定論的なオーケストレーターである。

担当範囲:

- Taskの読み込み
- Qwenの起動
- Supervisor AIの呼び出し
- Buildの実行
- Testの実行
- Git状態の取得
- ファイル情報の取得
- Supervisor AIから要求された許可済み操作の実行
- Supervisor AIのレスポンス検証
- PASS/FIX/HUMAN_REQUIREDの制御
- 最大反復回数の管理
- エラー処理


## 3. システム構成

                 Human
                   │
                   │ Task
                   ▼
          ┌─────────────────┐
          │    Controller   │
          │    Node.js      │
          └────────┬────────┘
                   │
                   ▼
          ┌─────────────────┐
          │  Supervisor AI  │
          │    Nemotron     │
          └────────┬────────┘
                   │
              作業指示
                   │
                   ▼
          ┌─────────────────┐
          │      Qwen       │
          │   Coding Agent  │
          └────────┬────────┘
                   │
                実作業
                   │
                   ▼
          ┌─────────────────┐
          │ Project Files   │
          │ Build / Test    │
          │ Git             │
          └────────┬────────┘
                   │
                   ▼
              Controller
                   │
                   └──────→ Supervisor AI

## 4. Supervisor AIが利用できる情報

Supervisor AIには、必要に応じて以下の情報を提供する。

### 必須情報

* Task
* Qwenの最新報告
* Build結果（Buildを要求したTaskの場合）
* Git status
* Git diff
* Iteration number

### プロジェクト情報

* Project Root
* docs/TODO.md
* 必要なプロジェクトファイル
* Solution / Project構成

### 必要に応じて取得する情報

* ソースコード
* XAML
* csproj / slnx
* migration
* configuration
* test code
* test result
* エラーログ

## 5. Supervisor AIの調査方式

Supervisor AIは、与えられた情報だけで判断できない場合、
追加調査を要求できる。

例:

{
  "action": "REQUEST_INFORMATION",
  "requests": [
    {
      "type": "READ_FILE",
      "path": "ComfyUI.PromptDictionary.Desktop/ViewModels/MainViewModel.cs"
    }
  ]
}

Controllerは要求された操作が許可されたものである場合のみ実行する。

取得した結果をSupervisor AIへ返し、
Supervisor AIは判断を継続する。

## 6. Controllerが提供する操作

初期実装では以下の操作を許可する。

### READ_FILE

指定ファイルを読み取る。

### GIT_STATUS

Git statusを取得する。

### GIT_DIFF

Git diffを取得する。

### PROJECT_TREE

プロジェクト構造を取得する。

### BUILD

dotnet buildを実行する。

### TEST

dotnet testを実行する。

## 7. Supervisor AIの責務

Supervisor AIは以下の順序で判断する。

### Step 1

Taskの要求を確認する。

### Step 2

Qwenが実際に何を行ったか確認する。

### Step 3

Qwenの報告と実際の状態に矛盾がないか確認する。

### Step 4

必要に応じて追加情報を要求する。

### Step 5

実装結果を評価する。

### Step 6

Build / Test結果を評価する。

### Step 7

以下のいずれかを判断する。

* PASS
* FIX
* HUMAN_REQUIRED

## 8. PASS

PASSは以下をすべて満たした場合のみ許可する。

* Taskの要求を満たしている
* 必要なコード変更が完了している
* 明らかな実装上の問題がない
* 必須Buildが成功している
* 必須Testが成功している
* Qwenの報告と実際の状態に矛盾がない
* 未解決の重大な問題がない

Supervisor AIが「問題なさそう」と判断しただけでは
PASS条件を満たしたことにはならない。

## 9. FIX

以下の場合はFIXとする。

* Taskを満たしていない
* 実装に問題がある
* Buildに失敗している
* Testに失敗している
* Qwenの報告と実際の状態が一致しない
* 必要な処理が未実装
* 修正内容が不十分
* 追加調査によって問題が判明した

## 10. HUMAN_REQUIRED

Supervisor AIだけでは安全に判断できない場合、
HUMAN_REQUIREDとする。

例:

* Taskの要求自体が曖昧
* 複数の設計方針から選択が必要
* 破壊的な変更が必要
* データベース構造を大幅に変更する必要がある
* 外部仕様の確認が必要
* Supervisor AIが判断材料を取得できない
* 同じ問題を複数回修正しても解決しない

## 11. Buildの扱い

Taskに

BUILD_REQUIRED: true

が指定されている場合、
Build成功をPASSの必須条件とする。

Build exit codeが0以外の場合、

PASSは禁止

とする。

このルールはSupervisor AIではなく
Controllerが保証する。

## 12. Testの扱い

TaskにTest実行が要求されている場合、
Test成功をPASSの必須条件とする。

Test失敗時はPASSを禁止する。

## 13. Gitの扱い

Supervisor AIはGit statusおよびGit diffを確認し、
Qwenの報告と実際の変更内容が一致しているか確認する。

Taskでコード変更が要求されているにもかかわらず
変更が存在しない場合は問題として扱う。

Taskで変更禁止と指定されている場合、
変更が存在すれば問題として扱う。

## 14. Qwenへの修正指示

Supervisor AIがFIXと判断した場合、
具体的な修正指示を生成する。

修正指示には可能な限り以下を含める。

* 問題点
* 根拠
* 対象ファイル
* 対象箇所
* 修正内容
* 修正後に確認すべき内容

「修正してください」のような
抽象的な指示だけを避ける。

## 15. 推測禁止

Supervisor AIおよびQwenは、
実ファイルを確認せずにAPI・型・構造を推測して
修正方針を決定してはならない。

不明な場合は追加情報を要求する。

## 16. Supervisor AIの出力

Supervisor AIの出力は機械処理可能なJSONとする。

基本形式:

{
  "decision": "PASS | FIX | HUMAN_REQUIRED",
  "summary": "判断の概要",
  "reasoning": [
    "判断根拠1",
    "判断根拠2"
  ],
  "instructions": [
    "Qwenへの具体的な指示"
  ],
  "requests": []
}

追加調査が必要な場合:

{
  "decision": "REQUEST_INFORMATION",
  "summary": "追加調査が必要",
  "reasoning": [
    "判断に必要な情報が不足している"
  ],
  "instructions": [],
  "requests": [
    {
      "type": "READ_FILE",
      "path": "..."
    }
  ]
}

## 17. Controllerによる出力検証

ControllerはSupervisor AIの出力をそのまま信用しない。

最低限以下を検証する。

* JSONとして解析可能か
* decisionが許可された値か
* 必須フィールドが存在するか
* REQUEST_INFORMATIONのrequestが許可された操作か
* BUILD_REQUIRED=trueかつBuild失敗の場合にPASSしていないか
* 最大Iterationを超えていないか

## 18. Iteration

Supervisor loopには最大反復回数を設定する。

現在の暫定値:

MAX_ITERATIONS = 5

最大回数に到達した場合、
自動的にHUMAN_REQUIREDとして終了する。

## 19. エラー時の扱い

以下の場合は自動継続しない。

* Qwen起動失敗
* OpenRouter通信失敗
* Supervisor AIの不正レスポンス
* Controller内部エラー
* 必須情報の取得失敗
* 同一問題の無限ループ

必要に応じてHUMAN_REQUIREDとして終了する。

## 20. セキュリティ / 操作制限

Supervisor AIが任意のコマンドを直接実行することは禁止する。

Controllerが許可した操作のみ実行可能とする。

特に以下は初期実装ではSupervisor AIから直接実行させない。

* 任意のPowerShellコマンド
* ファイル削除
* Git reset
* Git checkout
* Git push
* 外部へのファイル送信

## 21. 重要な設計原則

### LLMに任せるもの

* 状況理解
* コードレビュー
* 原因分析
* 設計判断
* 修正方針
* Qwenへの指示
* 完了判断

### Controllerに任せるもの

* ファイル取得
* Build
* Test
* Git情報取得
* 操作権限管理
* JSON検証
* PASS条件の機械的保証
* Iteration管理
* エラー処理

### Qwenに任せるもの

* コード調査
* コード変更
* Build / Test
* 実際の開発作業

## 22. 最終目標

人間が現在行っている以下の作業を自動化する。

Qwenの報告を読む
↓
本当にそうなっているか確認する
↓
必要ならファイルを見る
↓
Buildする
↓
エラーを見る
↓
実装を評価する
↓
Qwenに次の指示を出す
↓
再確認する
↓
問題なければ完了

最終的には人間は、

Taskを与える
↓
Supervisorの最終結果を見る

だけでPromptDictionaryの開発を進められる状態を目指す。
