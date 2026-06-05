require('dotenv').config();
const { chromium } = require('playwright');

const VOAT_SYNC_MARKER = '[VOAT-SYNC]';
const MONTHS_TO_PROCESS = 3; // 処理する月数（当月含む3ヶ月分）

// 現在選択されている日付のレッスン情報を抽出
async function extractCurrentDateReservations(page) {
  return await page.evaluate(() => {
    const extractedData = [];
    const yearInput = document.querySelector('input.cur-year');
    const year = yearInput && yearInput.value ? yearInput.value : new Date().getFullYear().toString();
    const dateElement = document.querySelector('.pickup-date');
    const monthDay = dateElement ? dateElement.innerText.trim() : '';
    // MM/DD → YYYY-MM-DD
    const fullDate = monthDay ? `${year}-${monthDay.replace('/', '-')}` : '';
    if (!fullDate) return [];

    const rows = document.querySelectorAll('table.sec tbody tr');
    rows.forEach(row => {
      const timeText = row.querySelector('.td-date')?.innerText.trim() || '';
      let startTime = '', endTime = '';
      if (timeText.includes('~')) {
        const parts = timeText.split('~');
        startTime = parts[0].trim();
        endTime = parts[1].trim();
      }
      if (!startTime || !endTime) return;

      const studio = row.querySelector('.td-studio')?.innerText.trim().replace(/\n/g, ' ') || '';
      const lessonCell = row.querySelector('.td-lesson');
      if (!lessonCell) return;

      const typeEl = lessonCell.querySelector('.td-lesson-cat');
      const type = typeEl ? typeEl.innerText.trim() : '';
      if (!type) return; // 空枠はスキップ

      // レッスン欄の全テキストを取得（PERSONAL/GROUP/EVENT も含む）
      const rawText = lessonCell.innerText.trim();
      const title = rawText
        .replace(/\n+/g, ' ')       // 改行をスペースに
        .replace(/\s{2,}/g, ' ')     // 連続スペースを1つに
        .trim() || 'レッスン';

      // 個別データも保持（description用）
      const bikouEls = lessonCell.querySelectorAll('.td-lesson-bikou');
      const content = bikouEls.length > 0 ? bikouEls[0].innerText.trim() : '';
      const studentEls = lessonCell.querySelectorAll('.td-lesson-student');
      const students = Array.from(studentEls).map(el => el.innerText.trim()).filter(Boolean);

      extractedData.push({ fullDate, startTime, endTime, studio, type, content, students, title });
    });
    return extractedData;
  });
}

// 現在表示中の月の予約可能日を取得
async function getReservableDates(page) {
  return await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.flatpickr-day:not(.prevMonthDay):not(.nextMonthDay)'))
      .filter(el => el.classList.contains('js-modal-reserve-open') || el.classList.contains('js-modal-lesson-open'))
      .map(el => el.getAttribute('aria-label'))
      .filter(Boolean);
  });
}

// 1ヶ月分の全日付を巡回してレッスン情報を取得
async function processMonth(page) {
  const results = [];
  const dates = await getReservableDates(page);
  if (dates.length === 0) return results;

  console.log(`  ${dates.length} 件の日付を処理中...`);
  for (const dateLabel of dates) {
    const selector = `.flatpickr-day:not(.prevMonthDay):not(.nextMonthDay)[aria-label="${dateLabel}"]`;
    await page.click(selector);
    await page.waitForTimeout(1500);

    const dayRes = await extractCurrentDateReservations(page);
    results.push(...dayRes);
    if (dayRes.length > 0) {
      console.log(`    ${dateLabel}: ${dayRes.length} 件のレッスン`);
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
        await page.click('.flatpickr-next-month');
        await page.waitForTimeout(1000);
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
    console.log(JSON.stringify(allReservations, null, 2));
    console.log('================================\n');

    // ===== Google Calendar 連携 =====
    if (allReservations.length === 0) {
      console.log('レッスンが見つかりませんでした。');
    } else if (!process.env.GOOGLE_CALENDAR_ID || !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
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

      // --- 1. 日付範囲を算出 ---
      const allDates = allReservations.map(r => r.fullDate).sort();
      const minDate = allDates[0];
      const maxDate = allDates[allDates.length - 1];
      const rangeStart = `${minDate}T00:00:00+09:00`;
      const rangeEnd = `${maxDate}T23:59:59+09:00`;

      // --- 2. 期間内の既存イベントをすべて取得 ---
      console.log(`期間 ${minDate} ~ ${maxDate} の既存イベントを検索中...`);
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

      // --- 3. 期間内の既存イベントをすべて削除（古いデータをクリーンアップ）---
      console.log(`\n既存イベント ${existingEvents.length} 件をすべて削除中...`);
      for (const ev of existingEvents) {
        try {
          console.log(`  [削除] ${ev.start?.dateTime || ev.start?.date} : ${ev.summary}`);
          await calendar.events.delete({ calendarId, eventId: ev.id });
        } catch (delErr) {
          // 既に削除済みの場合などはスキップ
          if (delErr.code !== 410) {
            console.error(`  [削除エラー] ${ev.summary}: ${delErr.message}`);
          }
        }
      }

      // --- 4. 最新のVOAT情報で全件新規登録 ---
      console.log(`\n最新の予定 ${allReservations.length} 件を登録中...`);
      for (const res of allReservations) {
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
