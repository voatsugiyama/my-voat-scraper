/**
 * Googleスプレッドシート 直接マトリックス同期モジュール
 * （休みグレー、予約済み8pt固定、空き枠白、過去日保護、API軽量化対応）
 */

const { google } = require('googleapis');

// 時間スロットの定義 (11:00 〜 21:30, 22スロット)
const START_H = 11;
const END_H = 21;
const TIME_SLOTS = [];
for (let h = START_H; h <= END_H; h++) {
  TIME_SLOTS.push(`${String(h).padStart(2, '0')}:00`);
  TIME_SLOTS.push(`${String(h).padStart(2, '0')}:30`);
}

// 色の定義 (RGB 0.0〜1.0)
const COLOR_WHITE = { red: 1.0, green: 1.0, blue: 1.0 };
const COLOR_SAT = { red: 0.93333334, green: 0.95686275, blue: 1.0 };      // #eef4ff
const COLOR_SUN = { red: 1.0, green: 0.9490196, blue: 0.9490196 };        // #fff2f2
const COLOR_GROUP = { red: 0.7882353, green: 0.85490197, blue: 0.972549 }; // #c9daf8
const COLOR_OFF = { red: 0.8509804, green: 0.8509804, blue: 0.8509804 };    // #d9d9d9 (休み)

const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * Google Sheets API 一時的エラー（429 / 5xx / 通信瞬断）の自動リトライ補助関数
 * 429 (Quota exceeded per minute per user) は1分枠リセットを跨ぐよう長めのジッター付きバックオフを実行
 */
async function withSheetRetry(fn, label, maxRetries = 6) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = err.code || err.status || 0;
      const msg = err.message || '';
      const isRateLimit = code === 429 || /Quota exceeded|Rate Limit/i.test(msg);
      const isRetryable = isRateLimit || code === 500 || code === 502 || code === 503 || code === 504 ||
        /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|Backend Error/i.test(msg);
      if (!isRetryable || attempt >= maxRetries) {
        throw err;
      }
      const jitter = Math.floor(Math.random() * 5000);
      const waitMs = isRateLimit
        ? Math.min(12000 * attempt + jitter, 65000)
        : 1500 * Math.pow(2, attempt - 1) + jitter;
      console.warn(`    ⚠️ Google Sheets API 一時エラー (${label}) - ${Math.round(waitMs / 1000)}秒後にリトライします (${attempt}/${maxRetries}): ${msg}`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

// 列インデックス（1-based: 1=A, 26=Z, 27=AA, 32=AF）からアルファベット表記を算出
function getColumnLetter(colIndex) {
  let letter = '';
  let temp = colIndex;
  while (temp > 0) {
    const mod = (temp - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    temp = Math.floor((temp - mod) / 26);
  }
  return letter;
}

/**
 * 1つの月シートまたは閲覧用シートにマトリックスを同期
 * @param {string|null} sourceSheetTitle 閲覧用シート同期時に参照する元月シート名（月替わり時の前月データ混入・結合競合を防止）
 */
async function syncMonthToSpreadsheet(sheets, spreadsheetId, targetSheetTitle, year, month, daysDataMap, metaSheets, isCurrentMonth = false, todayDate = 1, sourceSheetTitle = null) {
  let targetSheet = metaSheets.find(s => s.properties.title === targetSheetTitle);
  let sheetId;
  const isNewSheet = !targetSheet;
  let dimensionChanged = false;

  const daysInMonth = new Date(year, month, 0).getDate();
  const reqCols = daysInMonth + 1; // A列(時間) + 1〜daysInMonth (30日の月=31列, 31日の月=32列)
  const reqRows = TIME_SLOTS.length + 2; // 1行目:曜日, 2行目:日付, 3〜24行目:データ (計24行)

  if (isNewSheet) {
    console.log(`  ➕ シート「${targetSheetTitle}」を新規作成します...`);
    const addRes = await withSheetRetry(
      () => sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: targetSheetTitle,
                  gridProperties: {
                    rowCount: reqRows,
                    columnCount: reqCols,
                    frozenRowCount: 2,
                    frozenColumnCount: 1,
                  },
                },
              },
            },
          ],
        },
      }),
      `addSheet(${targetSheetTitle})`
    );
    const addedSheet = addRes.data.replies[0].addSheet;
    sheetId = addedSheet.properties.sheetId;
    metaSheets.push(addedSheet);
    targetSheet = addedSheet;
  } else {
    sheetId = targetSheet.properties.sheetId;
    const currentCols = targetSheet.properties.gridProperties?.columnCount || 0;
    const currentRows = targetSheet.properties.gridProperties?.rowCount || 0;

    // 【重要・月替わり対応】30日月 ➔ 31日月 等で列数が不足・変動している場合は、結合解除の上でグリッドサイズを自動調整
    if (currentCols !== reqCols || currentRows !== reqRows) {
      dimensionChanged = true;
      console.log(`  📐 シート「${targetSheetTitle}」のサイズを自動調整中: ${currentCols}列 -> ${reqCols}列`);
      const resizeRequests = [];
      if (currentCols > 1 && currentRows > 2) {
        resizeRequests.push({
          unmergeCells: {
            range: {
              sheetId,
              startRowIndex: 2,
              endRowIndex: currentRows,
              startColumnIndex: 1,
              endColumnIndex: currentCols,
            },
          },
        });
      }
      resizeRequests.push({
        updateSheetProperties: {
          properties: {
            sheetId,
            gridProperties: {
              rowCount: reqRows,
              columnCount: reqCols,
              frozenRowCount: 2,
              frozenColumnCount: 1,
            },
          },
          fields: 'gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount)',
        },
      });
      await withSheetRetry(
        () => sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: resizeRequests },
        }),
        `resizeSheet(${targetSheetTitle})`
      );
      if (targetSheet.properties.gridProperties) {
        targetSheet.properties.gridProperties.columnCount = reqCols;
        targetSheet.properties.gridProperties.rowCount = reqRows;
      }
      targetSheet.merges = (targetSheet.merges || []).filter(m => m.startRowIndex < 2 && m.startColumnIndex < 1);
    }
  }

  console.log(`  📊 シート「${targetSheetTitle}」(ID: ${sheetId}) のマトリックス同期中...`);

  // 【重要】既存シート（閲覧用シートの場合は対応する当月/翌月シート）の全セルデータおよび結合情報を読み取って、手動設定されたグレー枠（休み）や結合予約枠を保護
  let existingGridData = null;
  let existingMerges = [];
  const readSheetTitle = sourceSheetTitle || targetSheetTitle;
  const readTargetSheet = metaSheets.find(s => s.properties.title === readSheetTitle);
  if (readTargetSheet) {
    try {
      const endColLetter = getColumnLetter(daysInMonth + 1);
      const pastRes = await withSheetRetry(
        () => sheets.spreadsheets.get({
          spreadsheetId,
          ranges: [`${readSheetTitle}!B1:${endColLetter}24`],
          includeGridData: true,
        }),
        `getGridData(${readSheetTitle})`
      );
      if (pastRes.data.sheets && pastRes.data.sheets[0]) {
        const allRows = pastRes.data.sheets[0].data?.[0]?.rowData || [];
        const expectedFirstDayName = DAY_NAMES[new Date(year, month - 1, 1).getDay()];
        const actualFirstDayName = allRows[0]?.values?.[0]?.formattedValue || allRows[0]?.values?.[0]?.userEnteredValue?.stringValue || '';

        // 1日（B1セル）の曜日が対象年月と一致する場合のみ既存データを引き継ぐ（月替わり直後の前月データ混入を100%防止）
        if (!actualFirstDayName || actualFirstDayName === expectedFirstDayName) {
          existingMerges = pastRes.data.sheets[0].merges || [];
          existingGridData = allRows.slice(2); // 3行目（index 2）以降がデータ行
        } else {
          console.log(`    🔄 月替わりを検知したため前月データの引き継ぎをリセットします (${readSheetTitle}: ${actualFirstDayName} -> ${expectedFirstDayName})`);
        }
      }
    } catch (readErr) {
      console.warn(`    ⚠️ 既存セル読み取りスキップ (${readSheetTitle}): ${readErr.message}`);
    }
  }

  // ヘッダー行と時間列の準備
  const headerRow1 = [{ userEnteredValue: { stringValue: '開始時間' }, userEnteredFormat: { horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', textFormat: { bold: true, fontSize: 8 }, backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 } } }];
  const headerRow2 = [{ userEnteredValue: { stringValue: '' }, userEnteredFormat: { horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', textFormat: { bold: true, fontSize: 8 }, backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 } } }];

  for (let d = 1; d <= daysInMonth; d++) {
    const dayOfWeek = new Date(year, month - 1, d).getDay();
    const dayName = DAY_NAMES[dayOfWeek];
    const isSat = dayOfWeek === 6;
    const isSun = dayOfWeek === 0;
    const bg = isSat ? COLOR_SAT : isSun ? COLOR_SUN : COLOR_WHITE;

    headerRow1.push({
      userEnteredValue: { stringValue: dayName },
      userEnteredFormat: {
        horizontalAlignment: 'CENTER',
        verticalAlignment: 'MIDDLE',
        textFormat: { bold: true, fontSize: 10 },
        backgroundColor: bg,
      },
    });

    headerRow2.push({
      userEnteredValue: { numberValue: d },
      userEnteredFormat: {
        horizontalAlignment: 'CENTER',
        verticalAlignment: 'MIDDLE',
        textFormat: { bold: true, fontSize: 11 },
        backgroundColor: bg,
      },
    });
  }

  // 22行のデータ行を構築
  const dataRows = [];
  const mergeRequests = [];

  for (let rIdx = 0; rIdx < TIME_SLOTS.length; rIdx++) {
    const timeStr = TIME_SLOTS[rIdx];
    const rowCells = [
      {
        userEnteredValue: { stringValue: timeStr },
        userEnteredFormat: {
          horizontalAlignment: 'CENTER',
          verticalAlignment: 'MIDDLE',
          textFormat: { bold: true, fontSize: 8 },
          backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 },
        },
      },
    ];

    for (let d = 1; d <= daysInMonth; d++) {
      const colIdx = d; // 1-based column in sheet (1 = B列)
      const dayOfWeek = new Date(year, month - 1, d).getDay();
      const isSat = dayOfWeek === 6;
      const isSun = dayOfWeek === 0;
      const defaultBg = isSat ? COLOR_SAT : isSun ? COLOR_SUN : COLOR_WHITE;

      const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const dayData = daysDataMap[dateKey];

      // 既存セルの状態（手動設定のグレーや予約枠）をチェック
      let oldCell = null;
      let isOldGrey = false;
      let oldFormattedVal = '';
      if (existingGridData && existingGridData[rIdx] && existingGridData[rIdx].values && existingGridData[rIdx].values[d - 1]) {
        oldCell = existingGridData[rIdx].values[d - 1];
        oldFormattedVal = oldCell.formattedValue || (oldCell.userEnteredValue ? oldCell.userEnteredValue.stringValue : '') || '';
        const bg = oldCell.userEnteredFormat?.backgroundColor || {};
        const r_c = bg.red ?? 1;
        const g_c = bg.green ?? 1;
        const b_c = bg.blue ?? 1;
        isOldGrey = (r_c < 0.95 && g_c < 0.95 && b_c < 0.95 && Math.abs(r_c - g_c) < 0.05);
      }

      // 【過去日保護】当月かつ今日より前でスキップされ、既存セルデータがある場合
      if (isCurrentMonth && d < todayDate && oldCell) {
        rowCells.push({
          userEnteredValue: oldCell.userEnteredValue || (oldCell.formattedValue ? { stringValue: oldCell.formattedValue } : { stringValue: '' }),
          userEnteredFormat: oldCell.userEnteredFormat || {
            horizontalAlignment: 'CENTER',
            verticalAlignment: 'MIDDLE',
            textFormat: { bold: true, fontSize: 8 },
            backgroundColor: defaultBg,
          },
        });
        const matchedPastMerge = existingMerges.find(
          m => m.startColumnIndex === colIdx && m.endColumnIndex === colIdx + 1 && m.startRowIndex === 2 + rIdx
        );
        if (matchedPastMerge && matchedPastMerge.endRowIndex > matchedPastMerge.startRowIndex + 1) {
          mergeRequests.push({
            mergeCells: {
              range: {
                sheetId,
                startRowIndex: matchedPastMerge.startRowIndex,
                endRowIndex: Math.min(matchedPastMerge.endRowIndex, reqRows),
                startColumnIndex: colIdx,
                endColumnIndex: colIdx + 1,
              },
              mergeType: 'MERGE_ALL',
            },
          });
        }
        continue;
      }

      // 新規データまたは未来日のデータ構築
      const dayInfo = dayData || { openSlots: [], reservations: [] };

      // 該当スロットのレッスン予約を探す
      const resList = dayInfo.reservations.filter(res => {
        const [sh, sm] = res.startTime.split(':').map(Number);
        const [eh, em] = res.endTime.split(':').map(Number);
        const [th, tm] = timeStr.split(':').map(Number);
        const startM = sh * 60 + sm;
        const endM = eh * 60 + em;
        const curM = th * 60 + tm;
        return curM >= startM && curM < endM;
      });

      const isOpen = dayInfo.openSlots.includes(timeStr);

      let cellValue = '';
      let cellBg = defaultBg;
      let cellFontSize = 8;

      if (resList.length > 0) {
        // 1. VOATマイページから取得した新規レッスン予約がある場合
        const ev = resList[0];
        const upper = (ev.title || '').toUpperCase().replace(/[Ａ-Ｚ]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0));
        const isGroup = upper.includes('GROUP');

        if (isGroup) {
          let cleanTitle = ev.title.replace(/\s*[\(（].*$/, '');
          cellValue = cleanTitle.replace(/GROUP\s*/i, 'GROUP\n');
          cellBg = COLOR_GROUP;
          cellFontSize = 5;
        } else {
          cellValue = '予約済み';
          cellBg = defaultBg;
          cellFontSize = 8;
        }

        // 予約の開始行であれば連続セル結合を計画
        const [sh, sm] = ev.startTime.split(':').map(Number);
        const [eh, em] = ev.endTime.split(':').map(Number);
        const [th, tm] = timeStr.split(':').map(Number);
        const startM = sh * 60 + sm;
        const endM = eh * 60 + em;
        const curM = th * 60 + tm;

        if (curM === startM) {
          const numBlocks = Math.max(1, Math.round((endM - startM) / 30));
          if (numBlocks > 1) {
            mergeRequests.push({
              mergeCells: {
                range: {
                  sheetId,
                  startRowIndex: 2 + rIdx,
                  endRowIndex: Math.min(2 + rIdx + numBlocks, reqRows),
                  startColumnIndex: colIdx,
                  endColumnIndex: colIdx + 1,
                },
                mergeType: 'MERGE_ALL',
              },
            });
          }
        }
      } else if (isOpen) {
        // 2. VOATマイページで受付中の稼働スロット（予約キャンセル・移動後の空き枠や新規オープン枠を含む） -> 白（土日は土日背景色）
        cellValue = '';
        cellBg = defaultBg;
        cellFontSize = 8;
      } else {
        // 3. VOATマイページで予約枠を設定していない時間帯・休講日 -> 自動でグレー（#d9d9d9）！
        cellValue = '';
        cellBg = COLOR_OFF;
        cellFontSize = 8;
      }

      rowCells.push({
        userEnteredValue: cellValue ? { stringValue: cellValue } : { stringValue: '' },
        userEnteredFormat: {
          horizontalAlignment: 'CENTER',
          verticalAlignment: 'MIDDLE',
          textFormat: { bold: true, fontSize: cellFontSize },
          backgroundColor: cellBg,
          wrapStrategy: 'WRAP',
        },
      });
    }

    dataRows.push({ values: rowCells });
  }

  // 同一列内で重複・交差する結合リクエスト、または範囲外の結合リクエストを安全に除外（APIの mergeCells 競合エラーを100%防止）
  const safeMergeRequests = [];
  for (const req of mergeRequests) {
    const r = req.mergeCells.range;
    if (
      r.startRowIndex < 2 ||
      r.endRowIndex > reqRows ||
      r.endRowIndex <= r.startRowIndex + 1 ||
      r.startColumnIndex < 1 ||
      r.endColumnIndex > reqCols ||
      r.endColumnIndex !== r.startColumnIndex + 1
    ) {
      continue;
    }
    const hasOverlap = safeMergeRequests.some(existing => {
      const er = existing.mergeCells.range;
      return (
        er.startColumnIndex === r.startColumnIndex &&
        r.startRowIndex < er.endRowIndex &&
        er.startRowIndex < r.endRowIndex
      );
    });
    if (!hasOverlap) {
      safeMergeRequests.push(req);
    }
  }

  // 書き込み対象シートに既存の結合がある場合、2行目（ヘッダー）と3行目（データ）を跨ぐ不正な手動結合があってもエラーにならないよう結合解除範囲を自動拡張
  let unmergeStartRow = 2;
  let unmergeStartCol = 1;
  const targetExistingMerges = targetSheet?.merges || [];
  for (const m of targetExistingMerges) {
    // A1:A2 (col 0..1, row 0..2) の正規ヘッダー結合は維持し、データ領域と交差する結合のみ対象
    if (m.endRowIndex > 2 && m.endColumnIndex > 1) {
      if (m.startRowIndex < unmergeStartRow) unmergeStartRow = m.startRowIndex;
      if (m.startColumnIndex < unmergeStartCol) unmergeStartCol = m.startColumnIndex;
    }
  }

  // batchUpdate リクエストの組み立て（既存シート時は枠線・列幅等の再描画を省略して高速化）
  const updateRequests = [
    // 1. データ領域の結合を一旦全解除
    {
      unmergeCells: {
        range: {
          sheetId,
          startRowIndex: unmergeStartRow,
          endRowIndex: reqRows,
          startColumnIndex: unmergeStartCol,
          endColumnIndex: reqCols,
        },
      },
    },
    // 2. ヘッダーと時間軸、全データセルを一括更新
    {
      updateCells: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: reqRows,
          startColumnIndex: 0,
          endColumnIndex: reqCols,
        },
        rows: [
          { values: headerRow1 },
          { values: headerRow2 },
          ...dataRows,
        ],
        fields: 'userEnteredValue,userEnteredFormat(horizontalAlignment,verticalAlignment,textFormat,backgroundColor,wrapStrategy)',
      },
    },
    // 3. 予約ブロックの結合
    ...safeMergeRequests,
  ];

  // 【API軽量化】新規作成シートまたはサイズ変更時のみ枠線・列幅・行高さを適用（既存シートはスキップしてAPI消費を削減）
  if (isNewSheet || dimensionChanged) {
    updateRequests.push(
      {
        updateBorders: {
          range: {
            sheetId,
            startRowIndex: 0,
            endRowIndex: reqRows,
            startColumnIndex: 0,
            endColumnIndex: reqCols,
          },
          top: { style: 'SOLID', color: { red: 0, green: 0, blue: 0 } },
          bottom: { style: 'SOLID', color: { red: 0, green: 0, blue: 0 } },
          left: { style: 'SOLID', color: { red: 0, green: 0, blue: 0 } },
          right: { style: 'SOLID', color: { red: 0, green: 0, blue: 0 } },
          innerHorizontal: { style: 'SOLID', color: { red: 0, green: 0, blue: 0 } },
          innerVertical: { style: 'SOLID', color: { red: 0, green: 0, blue: 0 } },
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
          properties: { pixelSize: 40 },
          fields: 'pixelSize',
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: reqCols },
          properties: { pixelSize: 35 },
          fields: 'pixelSize',
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: reqRows },
          properties: { pixelSize: 30 },
          fields: 'pixelSize',
        },
      }
    );
  }

  await withSheetRetry(
    () => sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: updateRequests },
    }),
    `batchUpdate(${targetSheetTitle})`
  );

  console.log(`  ✅ シート「${targetSheetTitle}」の同期完了！`);
}

/**
 * 全月および閲覧用シートへのマトリックス同期を一括実行
 */
async function syncAllMonthsToSpreadsheet(daysDataMap, spreadsheetId, keyFilePath, monthsToProcess = 3) {
  if (!keyFilePath) {
    console.log('\n※ Google認証情報がないため、スプレッドシートへの直接同期はスキップされました。');
    return;
  }

  console.log('\n--- Googleスプレッドシートへの直接マトリックス同期を開始します ---');
  const auth = new google.auth.GoogleAuth({
    keyFile: keyFilePath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const metaRes = await withSheetRetry(
    () => sheets.spreadsheets.get({ spreadsheetId }),
    'spreadsheets.get(meta)'
  );
  const metaSheets = metaRes.data.sheets;

  // 日本時間（JST）基準で現在日時を取得
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const todayDate = now.getDate();

  for (let m = 0; m < monthsToProcess; m++) {
    const targetDate = new Date(now.getFullYear(), now.getMonth() + m, 1);
    const y = targetDate.getFullYear();
    const mon = targetDate.getMonth() + 1;
    // 他講師の旧スクレイパー（スペースなし）と完全に隔離するため、年と月の間に半角スペースを入れた専用シート名を使用
    const sheetTitle = `${y}年 ${mon}月`;
    const isCurrentMonth = (m === 0);

    await syncMonthToSpreadsheet(sheets, spreadsheetId, sheetTitle, y, mon, daysDataMap, metaSheets, isCurrentMonth, todayDate);

    // スペースなしの同名月シートが存在する場合も最新状態で同期
    const legacyTitle = `${y}年${mon}月`;
    if (metaSheets.find(s => s.properties.title === legacyTitle)) {
      await syncMonthToSpreadsheet(sheets, spreadsheetId, legacyTitle, y, mon, daysDataMap, metaSheets, isCurrentMonth, todayDate, sheetTitle);
    }

    // 【閲覧用】今月・【閲覧用】当月（元月シート sheetTitle の保護データを参照してミラー同期）
    if (m === 0) {
      for (const viewName of ['【閲覧用】今月', '【閲覧用】当月']) {
        if (metaSheets.find(s => s.properties.title === viewName)) {
          await syncMonthToSpreadsheet(sheets, spreadsheetId, viewName, y, mon, daysDataMap, metaSheets, isCurrentMonth, todayDate, sheetTitle);
        }
      }
    }
    // 【閲覧用】翌月・【閲覧用】来月（元月シート sheetTitle の保護データを参照してミラー同期）
    if (m === 1) {
      for (const viewName of ['【閲覧用】翌月', '【閲覧用】来月']) {
        if (metaSheets.find(s => s.properties.title === viewName)) {
          await syncMonthToSpreadsheet(sheets, spreadsheetId, viewName, y, mon, daysDataMap, metaSheets, false, 1, sheetTitle);
        }
      }
    }
  }

  // 他講師の旧スクレイパーが月替わりで自動作成・再表示した旧シート名（スペースなし YYYY年M月）を自動で非表示化
  const visibleLegacySheets = metaSheets.filter(
    s => /^\d{4}年\d{1,2}月$/.test(s.properties.title) && !s.properties.hidden
  );
  if (visibleLegacySheets.length > 0) {
    const hideRequests = visibleLegacySheets.map(s => ({
      updateSheetProperties: {
        properties: { sheetId: s.properties.sheetId, hidden: true },
        fields: 'hidden',
      },
    }));
    await withSheetRetry(
      () => sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: hideRequests },
      }),
      'hideLegacySheets'
    );
    console.log(
      `🙈 旧仕様のダミーシートを自動非表示化しました: ${visibleLegacySheets.map(s => s.properties.title).join(', ')}`
    );
  }

  console.log('Googleスプレッドシートへの直接マトリックス同期がすべて完了しました！');
}

module.exports = {
  syncAllMonthsToSpreadsheet,
};
