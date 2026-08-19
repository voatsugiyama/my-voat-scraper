require('dotenv').config();
const { chromium } = require('playwright');

const VOAT_SYNC_MARKER = '[VOAT-SYNC]';
const MONTHS_TO_PROCESS = 3; // 処理する月数（当月含む3ヶ月分）

// 現在選択されている日付のレッスン情報を抽出
async function extractCurrentDateReservations(page, expectedAriaLabel) {
  return await page.evaluate(() => {
    const extractedData = [];
    const yearInput = document.querySelector('input.cur-year');
    const year = yearInput && yearInput.value ? yearInput.value.trim() : new Date().getFullYear().toString();
    const dateElement = document.querySelector('.pickup-date');
    const monthDay = dateElement ? dateElement.innerText.trim() : '';
    if (!monthDay) return { success: false, fullDate: '', data: [] };

    // MM/DD または M/D を YYYY-MM-DD に正規化
    const parts = monthDay.split('/');
    if (parts.length !== 2) return { success: false, fullDate: '', data: [] };
    const m = parts[0].trim().padStart(2, '0');
    const d = parts[1].trim().padStart(2, '0');
    const fullDate = `${year}-${m}-${d}`;

    const rows = document.querySelectorAll('table.sec tbody tr');
    rows.forEach(row => {
      const timeText = row.querySelector('.td-date')?.innerText.trim() || '';
      let startTime = '', endTime = '';
      if (timeText.includes('~')) {
        const timeParts = timeText.split('~');
        startTime = timeParts[0].trim();
        endTime = timeParts[1].trim();
      }
      if (!startTime || !endTime) return;

      const studio = row.querySelector('.td-studio')?.innerText.trim().replace(/\n/g, ' ') || '';
      const lessonCell = row.querySelector('.td-lesson');
      if (!lessonCell) return;

      const typeEl = lessonCell.querySelector('.td-lesson-cat');
      const type = typeEl ? typeEl.innerText.trim() : '';
      
      // レッスン欄の全テキストを取得（PERSONAL/GROUP/EVENT も含む）
      let rawText = lessonCell.innerText.trim();
      if (!rawText || rawText === '受付中' || rawText === '予約可' || rawText === '空き') return; // 空枠はスキップ

      // 不要なボタンUIテキスト（欠席フォロー動画を送信する等）を除去
      rawText = rawText
        .replace(/欠席フォロー動画を送信する\s*>>/g, '')
        .replace(/動画を送信する\s*>>/g, '')
        .replace(/\n+/g, ' ')       // 改行をスペースに
        .replace(/\s{2,}/g, ' ')     // 連続スペースを1つに
        .trim();

      if (!rawText) return;

      const title = rawText || 'レッスン';

      // 個別データも保持（description用）
      const bikouEls = lessonCell.querySelectorAll('.td-lesson-bikou');
      const content = bikouEls.length > 0 ? bikouEls[0].innerText.trim() : '';
      const studentEls = lessonCell.querySelectorAll('.td-lesson-student');
      const students = Array.from(studentEls).map(el => el.innerText.trim()).filter(Boolean);

      extractedData.push({ fullDate, startTime, endTime, studio, type, content, students, title });
    });
    return { success: true, fullDate, data: extractedData };
  });
}

// 現在表示中の月のすべての日付を取得（1日も漏らさず全走査）
async function getReservableDates(page) {
  return await page.evaluate(() => {
    const days = document.querySelectorAll('.flatpickr-day:not(.prevMonthDay):not(.nextMonthDay)');
    return Array.from(days)
      .map(el => {
        const ariaLabel = el.getAttribute('aria-label') || '';
        const dayNumber = parseInt(el.textContent.trim(), 10);
        return { ariaLabel, dayNumber };
      })
      .filter(item => item.ariaLabel && !isNaN(item.dayNumber));
  });
}

// 日付のクリックとAjax/DOM描画完了の確実な待機
async function selectDateAndWait(page, selector, dayNumber) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.click(selector);

      // .pickup-date の日付（日番号）がクリック対象と一致するまで待機
      await page.waitForFunction((expectedDay) => {
        const pickupEl = document.querySelector('.pickup-date');
        if (!pickupEl) return false;
        const text = pickupEl.innerText.trim();
        const parts = text.split('/');
        if (parts.length !== 2) return false;
        const day = parseInt(parts[1], 10);
        return day === expectedDay;
      }, dayNumber, { timeout: 8000 });

      // テーブル描画の安定化のため少し待機
      await page.waitForTimeout(400);
      return true;
    } catch (e) {
      console.warn(`    ⚠️ 日付選択待機リトライ (${attempt}/3): day=${dayNumber}`);
      await page.waitForTimeout(1000);
    }
  }
  return false;
}

// 1ヶ月分の全日付を巡回してレッスン情報を取得
async function processMonth(page) {
  const results = [];
  const dates = await getReservableDates(page);
  if (dates.length === 0) return results;

  console.log(`  当月全 ${dates.length} 日を完全走査中...`);
  for (const item of dates) {
    const selector = `.flatpickr-day:not(.prevMonthDay):not(.nextMonthDay)[aria-label="${item.ariaLabel}"]`;
    const ok = await selectDateAndWait(page, selector, item.dayNumber);
    if (!ok) {
      console.error(`  ❌ 日付の選択・描画待機に失敗しました: ${item.ariaLabel}`);
      continue;
    }

    const extractResult = await extractCurrentDateReservations(page, item.ariaLabel);
    if (extractResult && extractResult.success) {
      // 抽出された日付とクリックした日番号の整合性チェック（別日の誤抽出を100%遮断）
      const extractedDay = parseInt(extractResult.fullDate.split('-')[2], 10);
      if (extractedDay !== item.dayNumber) {
        console.warn(`  ⚠️ 日付不一致を検知 (期待: ${item.dayNumber}日, 取得: ${extractedDay}日) - スキップします`);
        continue;
      }

      results.push(...extractResult.data);
      if (extractResult.data.length > 0) {
        console.log(`    ✅ ${extractResult.fullDate} (${item.ariaLabel}): ${extractResult.data.length} 件のレッスン抽出`);
      }
    }
  }
  return results;
}

(async () => {
  const loginId = process.env.VOAT_LOGIN_ID;
  const password = process.env.VOAT_PASSWORD;
  if (!loginId || !password) {
    console.error('エラー: .env ファイルに VOAT_LOGIN_ID と VOAT_PASSWORD を設定してください。');
    process.exit(1);
  }

  console.log('ブラウザを起動しています...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // ===== ログイン =====
    console.log('ログインページにアクセスしています...');
    await page.goto('https://www.voat.co.jp/instmypage/login.html', { waitUntil: 'networkidle' });
    console.log('ログイン情報を入力しています...');
    await page.fill('input[type="text"]', loginId);
    await page.fill('input[type="password"]', password);
    console.log('ログインを実行しています...');
    await page.click('input[value="ログイン"]');
    console.log('ログイン完了を待機しています...');
    try {
      await page.waitForURL('**/instmypage/', { timeout: 15000 });
      console.log('ログインに成功しました。');
    } catch (urlErr) {
      console.error('エラー: ログイン後にマイページに遷移できませんでした。VOAT_LOGIN_ID や VOAT_PASSWORD が間違っている可能性があります。');
      await page.screenshot({ path: 'login_error.png' }).catch(() => {});
      process.exit(1);
    }
    await page.waitForTimeout(2000);

    // ===== レッスン情報ページへ移動 =====
    console.log('レッスン情報ページに移動しています...');
    await page.goto('https://www.voat.co.jp/instmypage/lesson.html', { waitUntil: 'networkidle' });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    // ===== すべての月を巡回してデータ取得 =====
    const allReservations = [];

    for (let m = 0; m < MONTHS_TO_PROCESS; m++) {
      if (m > 0) {
        const prevMonthText = await page.evaluate(() => document.querySelector('.cur-month')?.textContent?.trim() || '');
        await page.click('.flatpickr-next-month');

        // 月表示が切り替わるまで待機
        await page.waitForFunction((oldMonth) => {
          const currentMonth = document.querySelector('.cur-month')?.textContent?.trim() || '';
          return currentMonth !== '' && currentMonth !== oldMonth;
        }, prevMonthText, { timeout: 10000 }).catch(() => {});

        await page.waitForTimeout(1500);
      }
      const monthLabel = await page.evaluate(() => {
        const month = document.querySelector('.cur-month')?.textContent?.trim() || '';
        const year = document.querySelector('input.cur-year')?.value || '';
        return `${year}年 ${month}`;
      });
      console.log(`\n📅 ${monthLabel} を処理中...`);
      const monthRes = await processMonth(page);
      allReservations.push(...monthRes);
    }

    console.log(`\n=== 全抽出結果: ${allReservations.length} 件 ===`);

    // ===== Google Calendar 連携 =====
    if (!process.env.GOOGLE_CALENDAR_ID || !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      console.log('※ .env にGoogleカレンダーの設定がないため、カレンダー連携はスキップされました。');
    } else {
      console.log('Google Calendarへの連携処理を開始します...');
      const { google } = require('googleapis');
      const auth = new google.auth.GoogleAuth({
        keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
        scopes: ['https://www.googleapis.com/auth/calendar'],
      });
      const calendar = google.calendar({ version: 'v3', auth });
      const calendarId = process.env.GOOGLE_CALENDAR_ID;

      // --- 1. 同期対象期間（当月1日〜3ヶ月後の末日）の算出 ---
      const now = new Date();
      const startYear = now.getFullYear();
      const startMonth = now.getMonth(); // 0-indexed
      const startStr = `${startYear}-${String(startMonth + 1).padStart(2, '0')}-01T00:00:00+09:00`;

      const endYearMonth = new Date(startYear, startMonth + MONTHS_TO_PROCESS, 0);
      const endYear = endYearMonth.getFullYear();
      const endMonth = endYearMonth.getMonth() + 1;
      const endDay = endYearMonth.getDate();
      const endStr = `${endYear}-${String(endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}T23:59:59+09:00`;

      const rangeStart = startStr;
      const rangeEnd = endStr;
      console.log(`同期対象期間: ${rangeStart} 〜 ${rangeEnd}`);

      // --- 2. 期間内の既存イベントをすべて取得 ---
      console.log(`期間内の既存イベントを検索中...`);
      let existingEvents = [];
      let pageToken = undefined;
      do {
        const res = await calendar.events.list({
          calendarId,
          timeMin: rangeStart,
          timeMax: rangeEnd,
          singleEvents: true,
          maxResults: 2500,
          pageToken,
        });
        existingEvents.push(...(res.data.items || []));
        pageToken = res.data.nextPageToken;
      } while (pageToken);
      console.log(`  既存イベント合計: ${existingEvents.length} 件`);

      // --- 3. 期間内の既存イベントをすべて削除（古いデータ・キャンセル分を完全クリーンアップ）---
      if (existingEvents.length > 0) {
        console.log(`\n既存イベント ${existingEvents.length} 件をすべて削除中...`);
        for (const ev of existingEvents) {
          try {
            await calendar.events.delete({ calendarId, eventId: ev.id });
          } catch (delErr) {
            if (delErr.code !== 410) {
              console.error(`  [削除エラー] ${ev.summary}: ${delErr.message}`);
            }
          }
        }
      }

      // --- 4. 最新のVOAT情報で全件新規登録 ---
      if (allReservations.length > 0) {
        // メモリ上での二重登録防止（安全ガード）
        const uniqueReservations = [];
        const seenKey = new Set();
        for (const res of allReservations) {
          const key = `${res.fullDate}_${res.startTime}_${res.endTime}_${res.studio}_${res.title}`;
          if (!seenKey.has(key)) {
            seenKey.add(key);
            uniqueReservations.push(res);
          }
        }

        console.log(`\n最新の予定 ${uniqueReservations.length} 件を登録中...`);
        for (const res of uniqueReservations) {
          const startDateTime = `${res.fullDate}T${res.startTime}:00+09:00`;
          const endDateTime = `${res.fullDate}T${res.endTime}:00+09:00`;
          const description = `${VOAT_SYNC_MARKER}\n種別: ${res.type}\n内容: ${res.content}\n生徒: ${res.students.join(', ')}`;

          const eventBody = {
            summary: res.title,
            location: res.studio,
            description,
            start: { dateTime: startDateTime, timeZone: 'Asia/Tokyo' },
            end: { dateTime: endDateTime, timeZone: 'Asia/Tokyo' },
          };

          try {
            console.log(`  [登録] ${startDateTime} : ${res.title}`);
            await calendar.events.insert({ calendarId, requestBody: eventBody });
          } catch (apiErr) {
            console.error(`  [エラー] ${startDateTime}: ${apiErr.message}`);
          }
        }
      } else {
        console.log('登録対象のレッスンはありませんでした。');
      }

      console.log('\nGoogle Calendarへの連携が完了しました。');
    }

  } catch (error) {
    console.error('スクレイピング中にエラーが発生しました:', error);
    process.exit(1);
  } finally {
    console.log('ブラウザを終了しています...');
    await browser.close();
  }
})();
