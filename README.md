# 盤路雷達 · HKJC × Pinnacle 賽前賠率雷達

香港賽馬會（HKJC）對 **Pinnacle（平博）** 的賽前（pre-match）賠率對比儀表板：以 **PinnAPI Edge** 的 Pinnacle 賠率計算 EV，並以 titan007 的 **Crown（皇冠）** 賠率僅計算同盤路鎖利和合成盤鎖利。所有資料落在本機 SQLite（`data.db`），可模擬落注及自動結算。

---

## 1. 快速開始

```bash
npm install
npm test           # 單元測試
npm run check      # TypeScript 全專案型別檢查
npm run build      # 前端 + 伺服器打包到 dist/
NODE_ENV=production node dist/index.cjs      # 生產模式，埠 5000
# 或開發模式
npm run dev
```

* 前端與 API 共用同一個埠（預設 `5000`，可用 `PORT` 覆寫）。
* 資料庫檔案：`data.db`（可用 `RADAR_DB` 覆寫）。首次啟動會自動建表（乾淨新庫，直接以 `pinnacle_*` 命名）。
* 備份：`npm run backup`（`backups/` 內保留最新 14 份，使用 `VACUUM INTO`，WAL 寫入中亦一致）。

---

## 2. 掃描策略（最新修正）

**只在每場比賽開賽前 30 分鐘內做密集掃描。** 視窗以外不做全場掃描，也不會逐場拉取賠率明細。

| 路徑 | 上游請求 | 用途 |
| --- | --- | --- |
| `GET /api/dashboard`（前端每 20 秒自動輪詢） | 只做輕量刷新：馬會單一 GraphQL 請求 + 已快取的 PinnAPI 賽程對照 | 讀取已儲存的資料、歷史、賽程；**永不觸發逐場明細掃描** |
| `POST /api/scan/window`、`npm run scan` | 輕量賽程 → 只選 `0 < minutes_to_kickoff <= 30` 的賽前場次 → 就地密集輪詢這些場次 | **唯一的自動化掃描路徑** |
| `POST /api/refresh`（人手按「更新」） | 密集視窗範圍的明細刷新 | 手動 |
| `POST /api/refresh?scope=full` | 全場明細掃描 | **只作人手動作，任何週期性路徑都不會走這條** |

### 密集視窗掃描器

* CLI：`npm run scan`（= `tsx scripts/scan-window.ts`）
* HTTP：`POST /api/scan/window`；`GET /api/scan/window` 只回報設定與目前在視窗內的場次（不發任何明細請求）
* 流程：抓輕量賽程／對照 → 篩選視窗內賽前場次 → 就地密集輪詢（重用同一份賽程與對照資料）→ **一旦建立任何模擬注單即時停止**
* 視窗內無賽事：立即回傳 `{"result":"NO_WINDOW"}`，**零筆供應商明細請求**；無新機會則回傳 `NO_ALERT`
* 已開賽 / 進行中 / 已完場 / 未對照到 Pinnacle 的場次一律排除
* CLI 結束碼：`0` = `NO_WINDOW`/`NO_ALERT`、`10` = `ALERT`、`1` = `ERROR`

### 持久伺服器自動頻率

| 環境變數 | 預設 | 範圍 | 說明 |
| --- | --- | --- | --- |
| `RADAR_SCAN_WINDOW_MIN` | `30` | 1–30 | 密集掃描視窗（分鐘） |
| `RADAR_SCAN_INTERVAL_SEC` | `30` | 5–120 | 密集輪詢間隔 |
| `RADAR_SIM_TARGET` | `0` | `0` 或正整數 | 模擬注單總目標；`0` 為無上限。達標後自動視窗掃描不會發出賽程或賠率請求。 |
| `RADAR_HOURLY_PREWARM` | 啟用 | `0` / `1` | 每小時預熱未來 24 小時賽事的配對與價格，不建立模擬注單 |

持久伺服器啟動後會在程序內自動執行上述兩個循環，不依賴瀏覽器或 Perplexity 頁面長開。達到 `RADAR_SIM_TARGET` 時，密集掃描會在任何上游請求前無動作返回。

---

## 3. Pinnacle 與 Crown 資料來源

### PinnAPI Edge — Pinnacle EV 主來源

`server/providers/pinnapi.ts` 以 PinnAPI Edge 作為唯一的 Pinnacle 主參考來源：

* 賽程：`GET /kit/v1/prematch/fixtures?sport_id=1`
* 個別賽事賠率：`GET /kit/v1/prematch/lines?event_id=<event_id>`
* 只接受完整賽事 `periods.num_0` 的 1X2、亞洲讓球和大細；十進制賠率必須大於 1，盤口必須為精確的 0.25 級距。
* 亞洲讓球保留 PinnAPI 主隊視角的符號（負數 = 主讓）；`closed` 只作市場狀態，不會把資料自動標記為過期。
* HKJC 是唯一的主賽程表。賽程對照會優先保存 `pinnapi:<event_id>`；PinnAPI 未能對照的場次才依序使用 OpticOdds、titan007 作 Pinnacle 後備。

憑證只可由環境變數提供，絕不應寫入程式碼或日誌：

```bash
PINNAPI_API_KEY=...                    # 或平台注入的 CUSTOM_CRED_PINNAPI_COM_TOKEN
CUSTOM_CRED_PINNAPI_COM_TOKEN=...
PINNAPI_BASE_URL=https://pinnapi.com   # 可選
CUSTOM_CRED_PINNAPI_COM_URL=...        # 可選平台端點
```

兩種金鑰都使用 `x-api-key`。沒有 PinnAPI 憑證時，狀態列會顯示 EV 主來源不可用；不會製造任何示範價格。

### Crown（titan007）— 僅鎖利

titan007 的 Crown 行只用於兩個鎖利類別：同盤路 HKJC × Crown 鎖利，以及 HKJC 合成盤 × Crown 鎖利。Crown 永遠不會用作 Pinnacle EV 基準，Crown 一側的固定模擬注碼為 HK$5,000。titan007 的賽果頁仍可作中性完場比分來源。

### 降級與示範模式

* PinnAPI 無法對照或沒有憑證時，才依序以 OpticOdds、titan007 對未對照場次作後備；已對照到 PinnAPI 的場次若讀取失敗，會保留最後一次成功快照而不改用其他書商。任何失敗都不清空、不編造價格。
* `RADAR_DEMO=1` 才會啟用示範資料，介面同時顯示明顯的 DEMO 橫幅。示範模式永不自動啟用。

---

## 4. 核心邏輯（沿用並保留）

* **HKJC 適配器**：`info.cld.hkjc.com/graphql/base/` 白名單查詢，HAD / HDC / HIL，只取 `PREEVENT`，價格本身已是十進制。
* **盤路正規化**（`server/lib/lines.ts`）：讓球一律存成「主隊讓球值」（負 = 主讓），大細存正值，全部貼齊 0.25 級距；PinnAPI 符號直接保留，titan007 的 `goals` 正負則在入庫時取負；非 0.25 級距一律拒收，不做無聲四捨五入。
* **完全同盤路比較**：只有雙方在**同一市場、同一正規化盤口**都有報價才會比較（`exactLine`）。
* **賽事對照**（`server/lib/matching.ts`）：開賽時間硬閘門 + 隊名相似度 + 聯賽 + 學習別名，附信心值與未配對原因。
* **鎖利數學**（`server/lib/arb.ts`）：`q = Σ 1/O`，只有 `q < 1` 才算鎖利；兩邊必須真正互補（H/A 同讓球、O/U 同總球數）；1X2 必須三面全覆蓋。直接鎖利及合成鎖利均不設 Pinnacle EV 門檻，3% 門檻只適用於一般 EV 注單。**模擬時 Crown 一邊固定 HK$5,000，馬會一邊按等額派彩反推、不設上限。**
* **EV**（`server/lib/ev.ts`）：以 **Pinnacle 無抽水（no-vig）機率**為真實機率基準，門檻 3%，馬會固定 HK$10,000；過期價、離群價、低信心對照都會標記並排除於模擬之外。
* **合成賠率**（`server/lib/synthetic.ts`）：純數學，重用已抓取的馬會主客和／讓球價，砌出 `+0 / +0.25 / +0.5 / +0.75`，再與 **Crown 對立單注**在完全相同的鏡像盤口上比較。
* **模擬與結算**：每個 `類別|賽事|盤口|選項` 只落一次；比分由 titan007 完場頁取得（中性比分資料，不涉賠率），支援全中／半中／走盤／半輸／輸。
* **去重**（`server/lib/dedupe.ts`）：機會狀態以合併方式更新，窄視窗掃描永不覆蓋整體狀態，`firstSeen` 保留 7 天。
* **介面**：繁體中文儀表板、深／淺色主題、冷啟動與降級橫幅、市場分頁、聯賽／時間／搜尋篩選、同盤路與只看機會開關、模擬投注紀錄頁，以及研究數據頁。
* **研究時間線**：以獨立資料表鎖定馬會 × Pinnacle 的初盤、T-30、T-15、T-5，涵蓋亞洲讓球、入球大細及角球大細；每筆保留來源時間與收集時間，完整及部分樣本分開標示。隔離收集器另行補上 HKJC 官方比分及角球結果，不會改動模擬結算、Wilson、Telegram 或落注流程。

---

## 5. API

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| `GET` | `/api/status` | 狀態、供應商健康、`pinnacleSource`（策略／選列方式）、`scan`（設定與最後一次掃描） |
| `GET` | `/api/dashboard` | 賽事、盤路、鎖利、EV、合成盤（只讀，附輕量刷新） |
| `POST` | `/api/refresh` | 人手刷新（密集視窗範圍）；`?scope=full` 為明確的人手全場掃描；`?scope=light` 只刷新賽程／馬會 |
| `GET` | `/api/scan/window` | 掃描設定 + 目前在視窗內的場次（零明細請求） |
| `POST` | `/api/scan/window` | 觸發一次密集視窗掃描（`NO_WINDOW` / `NO_ALERT` / `ALERT` / `TARGET_REACHED` / `ERROR`） |
| `GET` | `/api/simulations` | 模擬投注、分類匯總、實際盈虧 |
| `POST` | `/api/simulations/settle` | 立即結算 |
| `POST` | `/api/simulations/clear` | 清除（分類或全部） |
| `GET` | `/api/opportunities` | 機會去重狀態 |
| `GET` | `/api/history` | 單一盤路的賠率快照歷史 |
| `GET` | `/api/research` | 四階段研究時間線、完整度、來源時間及最終賽果 |
| `GET` | `/api/research/export?kind=timeline` | 按研究頁篩選條件匯出時間線 CSV；`kind=results` 匯出賽果 |
| `GET`/`POST` | `/api/backups` | 列出／建立 SQLite 備份 |

---

## 6. 環境變數

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `PORT` | `5000` | HTTP 埠 |
| `RADAR_DB` | `data.db` | SQLite 路徑 |
| `RADAR_BACKUP_DIR` | `backups` | 備份目錄 |
| `RADAR_BOOTSTRAP` | 啟用 | 設 `0` 可關閉啟動時的輕量暖機 |
| `RADAR_AUTO_SCAN` | 啟用 | `0` 可關閉每 30 秒視窗檢查 |
| `RADAR_HOURLY_PREWARM` | 啟用 | `0` 可關閉每小時 24 小時預熱配對 |
| `RADAR_RESEARCH_RESULTS` | 啟用 | `0` 可關閉每小時 HKJC 官方賽果補抓 |
| `RADAR_RESEARCH_RESULT_LOOKBACK_DAYS` | `7` | 每輪賽果補抓向後檢查日數，最多 30 日 |
| `RADAR_DEMO` | 關閉 | `1` = 明確示範模式 |
| `RADAR_SCAN_WINDOW_MIN` / `RADAR_SCAN_INTERVAL_SEC` | `30` / `30` | 密集掃描設定（見上） |
| `RADAR_SIM_TARGET` | `0` | 嚴格的模擬注單總數上限；`0` = 無上限 |
| `PINNAPI_API_KEY` / `CUSTOM_CRED_PINNAPI_COM_TOKEN` | — | PinnAPI Edge 的其中一種憑證（優先使用 custom token） |
| `PINNAPI_BASE_URL` / `CUSTOM_CRED_PINNAPI_COM_URL` | `https://pinnapi.com` | PinnAPI Edge 基底網址 |
| `PINNACLE_TITAN_COMPANY_ID` | `47` | titan007 選列的最後備援提示（名稱比對優先） |
| `RADAR_ACCESS_USER` / `RADAR_ACCESS_PASSWORD` | — | 生產儀表板 HTTP Basic 登入 |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | 持久伺服器 Telegram 通知設定 |

Telegram 通知由雷達伺服器直接送出，只在密集掃描建立新模擬注單後發送；同一張注單成功送達後會在 SQLite 記錄去重，不依賴 Perplexity 排程或瀏覽器長開。

---

## 7. DigitalOcean 持久部署

建議 Ubuntu 24.04、Singapore SGP1、Basic 1 GB Droplet。伺服器只需一次初始化：

```bash
sudo bash deploy/bootstrap-ubuntu.sh
sudo git clone <private-github-repo> /opt/odds-radar
cd /opt/odds-radar
sudo cp .env.example .env
sudo nano .env
sudo docker compose up -d --build
```

`data/` 與 `backups/` 是主機持久目錄，不會因映像重建而消失。GitHub Actions 需要設定 `DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KEY` 三個 Repository Secrets；每次推送 `master` 都會先跑型別檢查、測試及打包，全部通過後才更新伺服器。

---

## 8. 映射遷移

現有 SQLite 資料庫在啟動時只會對 `pinnacle_source_map` 加入 `pinnapi_id` 和 `pinnapi_reversed` 兩個欄位及索引；不會清除既有賽程、快照、機會或模擬資料。`matches.pinnacle_match_id` 保存目前啟用的來源 ID（通常為 `pinnapi:<event_id>`），而完整的 PinnAPI／OpticOdds／titan007 對照保存在 `pinnacle_source_map`。

---

## 9. 測試

```bash
npm test
```

* `tests/core.test.ts`：盤路正規化、鎖利／EV／合成數學、賽事對照、去重、結算。
* `tests/pinnapi.test.ts`：PinnAPI 賽程映射、父子賽事優先、`num_0` 價格解析、精確 0.25 盤口、無效價格與憑證設定。
* `tests/scan.test.ts`：
  * 視窗外 → `NO_WINDOW` 且**零筆明細請求**；
  * 視窗內 → 只掃描視窗內場次（每輪都只碰選中的場次，證明沒有全場掃描路徑）；
  * 已開賽 / 進行中 / 已完場 / 未對照 → 排除；
  * 模擬目標上限為嚴格總數，達標後不再保留插入容量；
  * 出現新的模擬注單即時停止；
  * Pinnacle 選列以名稱命中、明確封鎖皇冠列編號、無 Pinnacle 列時回傳降級（null）。
