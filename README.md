# 盤路雷達 · HKJC × Pinnacle 賽前賠率雷達

香港賽馬會（HKJC）對 **Pinnacle（平博）** 的賽前（pre-match）賠率對比儀表板：同盤路鎖利（arbitrage）、以 Pinnacle 無抽水機率為基準的正期望值（EV），以及由馬會主客和砌出的合成讓球盤比較，全部落在本機 SQLite（`data.db`）並可模擬落注、自動結算。

> **對手盤／基準書商已由「皇冠 Crown」全面改為「Pinnacle 平博」。** 程式碼、資料庫欄位、API 欄位、EV 基準、鎖利標籤與數學錨點、合成盤比較、介面文案與顏色、測試與文件都只認 Pinnacle。舊 Crown 識別碼一律不再存在（唯一例外是本檔的遷移說明）。

---

## 1. 快速開始

```bash
npm install
npm test           # 單元測試（72 項）
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
| `GET /api/dashboard`（前端每 20 秒自動輪詢） | 只做輕量刷新：馬會單一 GraphQL 請求 + 已快取的 titan007 賽程頁 | 讀取已儲存的資料、歷史、賽程；**永不觸發逐場明細掃描** |
| `POST /api/scan/window`、`npm run scan` | 輕量賽程 → 只選 `0 < minutes_to_kickoff <= 30` 的賽前場次 → 就地密集輪詢這些場次 | **唯一的自動化掃描路徑** |
| `POST /api/refresh`（人手按「更新」） | 密集視窗範圍的明細刷新 | 手動 |
| `POST /api/refresh?scope=full` | 全場明細掃描 | **只作人手動作，任何週期性路徑都不會走這條** |

### 密集視窗掃描器

* CLI：`npm run scan`（= `tsx scripts/scan-window.ts`）
* HTTP：`POST /api/scan/window`；`GET /api/scan/window` 只回報設定與目前在視窗內的場次（不發任何明細請求）
* 流程：抓輕量賽程／對照 → 篩選視窗內賽前場次 → 就地密集輪詢（重用同一份賽程與對照資料）→ **一旦出現新的鎖利機會即時停止**
* 視窗內無賽事：立即回傳 `{"result":"NO_WINDOW"}`，**零筆供應商明細請求**；無新機會則回傳 `NO_ALERT`
* 已開賽 / 進行中 / 已完場 / 未對照到 Pinnacle 的場次一律排除
* CLI 結束碼：`0` = `NO_WINDOW`/`NO_ALERT`、`10` = `ALERT`、`1` = `ERROR`

### 頻率仍然故意未定，**本次沒有建立任何排程／cron**

| 環境變數 | 預設 | 範圍 | 說明 |
| --- | --- | --- | --- |
| `RADAR_SCAN_WINDOW_MIN` | `30` | 1–30 | 密集掃描視窗（分鐘） |
| `RADAR_SCAN_INTERVAL_SEC` | `30` | 5–120 | 密集輪詢間隔 |
| `RADAR_SCAN_MAX_RUNTIME_SEC` | `240` | 30–290 | 單次總執行時間上限（硬上限 < 300 秒） |

要真正定期執行，日後自行把 `npm run scan` 或 `POST /api/scan/window` 掛上排程器即可；程式碼本身不會自行建立任何排程。

---

## 3. Pinnacle 資料來源（可替換適配器，兩種策略）

`server/providers/pinnacle.ts` 是唯一的 Pinnacle 適配器門面，內含兩種策略，**任何情況下都不會用其他書商（例如舊有的皇冠）冒充 Pinnacle**：

### (a) 官方／合作夥伴 API — `official-api`

Pinnacle 官方文件說明 **一般公眾的 API 存取已於 2025-07-23 關閉**，只有獲批帳戶可繼續使用；獲批後為 HTTPS + JSON + HTTP Basic 認證，提供 sports / fixtures / odds 端點（見 <https://github.com/pinnacleapi/pinnacleapi-documentation>）。

只有同時提供憑證時才會啟用：

```bash
PINNACLE_API_USERNAME=...   # 獲批帳戶
PINNACLE_API_PASSWORD=...
PINNACLE_API_BASE=https://api.pinnacle.com   # 可選
PINNACLE_SPORT_ID=29                         # 可選，29 = Soccer
```

實作於 `server/providers/pinnacle-api.ts`：`GET /v1/fixtures`、`GET /v1/odds?oddsFormat=Decimal`，只取 `period 0`（全場），並丟棄 `liveStatus=1` 的進行中賽事。若官方呼叫失敗，會記錄警告並改用 (b)（同樣是 Pinnacle 報價），狀態列會顯示提示。

### (b) titan007／球探網公開賠率頁 — `titan007`（免憑證，預設）

* 賽程：`bf.titan007.com/football/Next_YYYYMMDD.htm`、`Over_YYYYMMDD.htm`（含比分）
* 亞洲讓球：`vip.titan007.com/AsianOdds_n.aspx?id=<sId>`
* 大細：`vip.titan007.com/OverDown_n.aspx?id=<sId>`
* 主客和：`1x2d.titan007.com/<sId>.js`（UTF-8，含完整書商英文名）

**選列方式：以正規化書商名稱比對，而非假設任何固定 companyID。** titan007 會把書商名稱遮蔽成前綴（例如 `平*`、`Crow*`），所以 `server/providers/pinnacle-names.ts` 會：

1. 正規化可見標籤（去除遮蔽星號、空白、大小寫）；
2. 與 Pinnacle 別名清單（`pinnacle`、`pinnacle sports`、`平博`…）比對，遮蔽標籤以「前綴」方式命中；
3. 名稱都無法命中時，才使用可設定的列編號提示 `PINNACLE_TITAN_COMPANY_ID`（預設 `47`，2026-08-07 實測值），並在狀態中標示 `matchedBy = "id-hint"`；
4. **明確封鎖**舊有皇冠／澳門等列編號（`BLOCKED_COMPANY_IDS`，含 `3` 與 `545`），令皇冠報價永遠不可能被當成 Pinnacle。

主客和（1X2）feed 帶有完整名稱，所以純以名稱 `Pinnacle` 選列（實測列編號 177，但不依賴它）。

**實測（2026-08-07，本機沙盒）**：亞讓／大細頁存在 Pinnacle 列（可見標籤 `平*`，列 47，以名稱命中），1X2 feed 存在 `Pinnacle`（列 177）；例如 `sId=2961732` 取得 AH `-1 @ 2.00/1.88`、OU `3.5 @ 2.03/1.85`、1X2 `1.61/4.63/4.81`。**上游狀態：live。**

### 降級與示範模式

* 找不到 Pinnacle 列或 API 不可用 → 該場略過、`provider_health.mode = degraded`、狀態列顯示原因，並**保留最後一次成功的快照**（絕不清空、絕不編造價格、絕不替換書商）。
* `RADAR_DEMO=1` 才會啟用示範資料，介面同時顯示明顯的 DEMO 橫幅。示範模式永不自動啟用。

---

## 4. 核心邏輯（沿用並保留）

* **HKJC 適配器**：`info.cld.hkjc.com/graphql/base/` 白名單查詢，HAD / HDC / HIL，只取 `PREEVENT`，價格本身已是十進制。
* **盤路正規化**（`server/lib/lines.ts`）：讓球一律存成「主隊讓球值」（負 = 主讓），大細存正值，全部貼齊 0.25 級距；titan007 的 `goals` 正負與內部相反，入庫時取負；非 0.25 級距一律拒收，不做無聲四捨五入。
* **完全同盤路比較**：只有雙方在**同一市場、同一正規化盤口**都有報價才會比較（`exactLine`）。
* **賽事對照**（`server/lib/matching.ts`）：開賽時間硬閘門 + 隊名相似度 + 聯賽 + 學習別名，附信心值與未配對原因。
* **鎖利數學**（`server/lib/arb.ts`）：`q = Σ 1/O`，只有 `q < 1` 才算鎖利；兩邊必須真正互補（H/A 同讓球、O/U 同總球數）；1X2 必須三面全覆蓋。**模擬時 Pinnacle 一邊固定 HK$5,000，馬會一邊按等額派彩反推、不設上限。**
* **EV**（`server/lib/ev.ts`）：以 **Pinnacle 無抽水（no-vig）機率**為真實機率基準，門檻 3%，馬會固定 HK$10,000；過期價、離群價、低信心對照都會標記並排除於模擬之外。
* **合成賠率**（`server/lib/synthetic.ts`）：純數學，重用已抓取的馬會主客和／讓球價，砌出 `+0 / +0.25 / +0.5 / +0.75`，再與 **Pinnacle 對立單注**在完全相同的鏡像盤口上比較。
* **模擬與結算**：每個 `類別|賽事|盤口|選項` 只落一次；比分由 titan007 完場頁取得（中性比分資料，不涉賠率），支援全中／半中／走盤／半輸／輸。
* **去重**（`server/lib/dedupe.ts`）：機會狀態以合併方式更新，窄視窗掃描永不覆蓋整體狀態，`firstSeen` 保留 7 天。
* **介面**：繁體中文儀表板、深／淺色主題、冷啟動與降級橫幅、市場分頁、聯賽／時間／搜尋篩選、同盤路與只看機會開關、模擬投注紀錄頁。

---

## 5. API

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| `GET` | `/api/status` | 狀態、供應商健康、`pinnacleSource`（策略／選列方式）、`scan`（設定與最後一次掃描） |
| `GET` | `/api/dashboard` | 賽事、盤路、鎖利、EV、合成盤（只讀，附輕量刷新） |
| `POST` | `/api/refresh` | 人手刷新（密集視窗範圍）；`?scope=full` 為明確的人手全場掃描；`?scope=light` 只刷新賽程／馬會 |
| `GET` | `/api/scan/window` | 掃描設定 + 目前在視窗內的場次（零明細請求） |
| `POST` | `/api/scan/window` | 觸發一次密集視窗掃描（`NO_WINDOW` / `NO_ALERT` / `ALERT` / `ERROR`） |
| `GET` | `/api/simulations` | 模擬投注、分類匯總、實際盈虧 |
| `POST` | `/api/simulations/settle` | 立即結算 |
| `POST` | `/api/simulations/clear` | 清除（分類或全部） |
| `GET` | `/api/opportunities` | 機會去重狀態 |
| `GET` | `/api/history` | 單一盤路的賠率快照歷史 |
| `GET`/`POST` | `/api/backups` | 列出／建立 SQLite 備份 |

---

## 6. 環境變數

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `PORT` | `5000` | HTTP 埠 |
| `RADAR_DB` | `data.db` | SQLite 路徑 |
| `RADAR_BACKUP_DIR` | `backups` | 備份目錄 |
| `RADAR_BOOTSTRAP` | 啟用 | 設 `0` 可關閉啟動時的輕量暖機 |
| `RADAR_DEMO` | 關閉 | `1` = 明確示範模式 |
| `RADAR_SCAN_WINDOW_MIN` / `RADAR_SCAN_INTERVAL_SEC` / `RADAR_SCAN_MAX_RUNTIME_SEC` | `30` / `30` / `240` | 密集掃描設定（見上） |
| `PINNACLE_API_USERNAME` / `PINNACLE_API_PASSWORD` / `PINNACLE_API_BASE` / `PINNACLE_SPORT_ID` | — | 官方 API 策略 |
| `PINNACLE_TITAN_COMPANY_ID` | `47` | titan007 選列的最後備援提示（名稱比對優先） |

---

## 7. 遷移說明（唯一保留的 Crown 提及）

先前版本以「皇冠 Crown」（titan007 `companyID=3`）作對手盤，資料庫欄位為 `crown_match_id` 等。本版本**不做資料遷移**：schema 直接以 `pinnacle_match_id`、`provider='pinnacle'` 建立**全新乾淨資料庫**。若機器上仍有舊的 `data.db`，請改名或刪除後重新啟動；舊庫內的皇冠賠率與 Pinnacle 賠率不可互換，混用會使鎖利與 EV 計算失真。程式碼中已不存在任何 crown 識別碼。

---

## 8. 測試

```bash
npm test
```

* `tests/core.test.ts`（55 項）：盤路正規化、鎖利／EV／合成數學、賽事對照、去重、結算。
* `tests/scan.test.ts`（17 項）：
  * 視窗外 → `NO_WINDOW` 且**零筆明細請求**；
  * 視窗內 → 只掃描視窗內場次（每輪都只碰選中的場次，證明沒有全場掃描路徑）；
  * 已開賽 / 進行中 / 已完場 / 未對照 → 排除；
  * 設定夾在 300 秒硬上限以下（含 env 覆寫與非法值）；
  * 出現新鎖利即時停止；
  * Pinnacle 選列以名稱命中、明確封鎖皇冠列編號、無 Pinnacle 列時回傳降級（null）。
