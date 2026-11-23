require('dotenv').config();
const path = require('path');
const { scrapeVoatReservations } = require('./src/scraper');
const { syncReservationsToCalendar } = require('./src/calendarSync');
const { syncAllMonthsToSpreadsheet } = require('./src/sheetSync');
const { sendErrorAlert } = require('./src/notifier');

const MONTHS_TO_PROCESS = 3; // 処理する月数（当月含む3ヶ月分）
const KUMAMOTO_LOGIN_ID = 'beside.yuki.kumamoto@gmail.com';
const KUMAMOTO_SPREADSHEET_ID = '1vwLDxLeLrUb6icuYU9M0w4feTPpNf_mPxRItHSS30s4';
const TEACHER_SPREADSHEET_MAP_BY_REPO = {
  'besideyukikumamoto/voatreservation': '1vwLDxLeLrUb6icuYU9M0w4feTPpNf_mPxRItHSS30s4',
  'voat-fukuoka-inoue/my-voat-scraper': '1O-zmcECeN9YJXslShvdBvX9bvkp2Xr6VVe7c1ITQEeQ',
  'voat-tsuchida/my-voat-scraper-': '1YtBmcakBiNXi14G6ppWCkUtJg4y_mOp7A842GkLPBiQ',
  'voatfdance/rin': '18wlCdcAHQrcWm8ex9idsKUgbceX5OvYWg7sdWB-ldJU',
  'voatfdance/tetsuo': '1vosGXphY-kenOVZN_1zApnPdw__kAajEC6GPyjR3Kz4',
  'voatishii-creator/my-voat-scraper': '14_42uDfU0j4igX3Oq8FMKpcmcNV3lUq3jqrxk5e0B2A',
  'voatmatsuo/my-voat-scraper': '1-dwniNIwIJGu8lEWz9CzgYfkWcdsHQIV9BLjtdnjuxo',
  'voatmatsusaki/my-voat-scraper': '1_ZUeKvMJBCR0LwCm_Xz-HHc9uGxxL7F-gNTbluW_IyM',
  'voatsakai-star/my-voat-scraper': '1DapzY8rRJE7q3ImliukGzR036rEvFPXYiPTX4KbyIVE',
  'voatsetoguchi-stack/my-voat-scraper': '1HDz7JmHCMavgSRhtjWoIyKFzIwsvN3V1TFS7HAs5wL8',
  'voatsone/my-voat-scraper': '1LNr_iUE3SoCwa1GB-fyvPlwJlv3sWPfKKQmp_hkpWGc',
  'voatsugiyama/my-voat-scraper': '17-MrI7U-myygacfhnmrKPkIzVj7Oy6qUP6svLPqjVUs',
};
const TEACHER_SPREADSHEET_MAP_BY_CALENDAR = {
  'f9d54c9faf1fee48e1b7bf2f8d55619e872b52502f5e80cb7c29545f9b5e884d@group.calendar.google.com': '1vwLDxLeLrUb6icuYU9M0w4feTPpNf_mPxRItHSS30s4',
  '7c17519c1beee9804b1fc6f5ace58f8a36f78de24a29ab5971d09b75a14b766a@group.calendar.google.com': '1O-zmcECeN9YJXslShvdBvX9bvkp2Xr6VVe7c1ITQEeQ',
  'voat.tsuchida@gmail.com': '1YtBmcakBiNXi14G6ppWCkUtJg4y_mOp7A842GkLPBiQ',
  '36aebc5ea4e04bcd154939cdbfe69e76bc02b3200bf7e580ba2a291cc8cd8f8a@group.calendar.google.com': '18wlCdcAHQrcWm8ex9idsKUgbceX5OvYWg7sdWB-ldJU',
  '0624241b60cc8949f6fd2748e46d55c06e75be38fa21cfa474487496b07b505d@group.calendar.google.com': '1vosGXphY-kenOVZN_1zApnPdw__kAajEC6GPyjR3Kz4',
  'voat.ishii@gmail.com': '14_42uDfU0j4igX3Oq8FMKpcmcNV3lUq3jqrxk5e0B2A',
  'voat.matsuo@gmail.com': '1-dwniNIwIJGu8lEWz9CzgYfkWcdsHQIV9BLjtdnjuxo',
  'voat.matsusaki@gmail.com': '1_ZUeKvMJBCR0LwCm_Xz-HHc9uGxxL7F-gNTbluW_IyM',
  'voat.sakai@gmail.com': '1DapzY8rRJE7q3ImliukGzR036rEvFPXYiPTX4KbyIVE',
  'voat.setoguchi@gmail.com': '1HDz7JmHCMavgSRhtjWoIyKFzIwsvN3V1TFS7HAs5wL8',
  'voat.sone@gmail.com': '1LNr_iUE3SoCwa1GB-fyvPlwJlv3sWPfKKQmp_hkpWGc',
  'voat.sugiyama@gmail.com': '17-MrI7U-myygacfhnmrKPkIzVj7Oy6qUP6svLPqjVUs',
};
const KEY_FILE_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.SERVICE_ACCOUNT_PATH || path.join(__dirname, 'service-account.json');

(async () => {
  const startTime = Date.now();
  console.log('==============================================');
  console.log('🚀 VOAT予約スクレイパー＆直接同期システム 起動');
  console.log(`⏰ 実行開始: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`);
  console.log('==============================================');

  const loginId = process.env.VOAT_LOGIN_ID;
  const password = process.env.VOAT_PASSWORD;
  const calendarId = process.env.GOOGLE_CALENDAR_ID;

  if (!loginId || !password) {
    const err = new Error('環境変数 VOAT_LOGIN_ID または VOAT_PASSWORD が設定されていません。');
    console.error(err.message);
    await sendErrorAlert('初期化（環境変数チェック）', err);
    process.exit(1);
  }

  try {
    // ----------------------------------------------------
    // Step 1: VOATマイページ高速スクレイピング
    // ----------------------------------------------------
    console.log('\n【Step 1】VOATマイページのスクレイピングを開始します...');
    const allDaysData = await scrapeVoatReservations(loginId, password, MONTHS_TO_PROCESS);

    // 全予約のフラットリストおよび日付マップを作成
    const allReservations = [];
    const daysDataMap = {};
    for (const day of allDaysData) {
      daysDataMap[day.fullDate] = {
        openSlots: day.openSlots,
        reservations: day.reservations,
      };
      allReservations.push(...day.reservations);
    }

    console.log(`\n=== 抽出結果: 走査 ${allDaysData.length} 日分, 予約レッスン ${allReservations.length} 件 ===`);

    // ----------------------------------------------------
    // Step 2: Google Calendar 差分同期（レッスン予約のみ）
    // ----------------------------------------------------
    console.log('\n【Step 2】Google Calendarへの差分同期を開始します...');
    await syncReservationsToCalendar(allReservations, calendarId, KEY_FILE_PATH, MONTHS_TO_PROCESS);

    // ----------------------------------------------------
    // Step 3: Google Sheets 直接マトリックス同期（休みグレー＆8pt固定＆手動グレー保護）
    // ※他講師のアカウントで隈元先生のスプレッドシートが上書きされるのを防ぐため、
    //   明示SPREADSHEET_ID ＞ リポジトリ別マップ ＞ カレンダーID別マップ の順で各講師専用IDを解決
    // ----------------------------------------------------
    const isKumamoto = (loginId.trim().toLowerCase() === KUMAMOTO_LOGIN_ID);
    const repoKey = (process.env.GITHUB_REPOSITORY || '').trim().toLowerCase();
    const calKey = (calendarId || '').trim().toLowerCase();
    const mappedSpreadsheetId =
      TEACHER_SPREADSHEET_MAP_BY_REPO[repoKey] ||
      TEACHER_SPREADSHEET_MAP_BY_CALENDAR[calKey] ||
      '';
    const explicitSpreadsheetId = (process.env.SPREADSHEET_ID || '').trim();
    const safeExplicitId =
      explicitSpreadsheetId && (isKumamoto || explicitSpreadsheetId !== KUMAMOTO_SPREADSHEET_ID)
        ? explicitSpreadsheetId
        : '';
    const safeMappedId =
      mappedSpreadsheetId && (isKumamoto || mappedSpreadsheetId !== KUMAMOTO_SPREADSHEET_ID)
        ? mappedSpreadsheetId
        : '';
    const targetSpreadsheetId = safeExplicitId || safeMappedId || (isKumamoto ? KUMAMOTO_SPREADSHEET_ID : '');

    if (targetSpreadsheetId) {
      console.log(`\n【Step 3】Googleスプレッドシート (${targetSpreadsheetId}) への直接同期を開始します（手動グレー保護＆隔離対応版）...`);
      await syncAllMonthsToSpreadsheet(daysDataMap, targetSpreadsheetId, KEY_FILE_PATH, MONTHS_TO_PROCESS);
    } else {
      console.log('\n【Step 3】スプレッドシートIDが未設定のため、Google Calendar同期のみで完了します。');
    }

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n==============================================');
    console.log(`🎉 すべての同期処理が正常に完了しました！ (所要時間: ${elapsedSec} 秒)`);
    console.log('==============================================');

  } catch (error) {
    console.error('\n❌ 処理中に重大なエラーが発生しました:', error);

    // LINE宛てにエラーアラートを送信
    try {
      await sendErrorAlert('VOATスクレイパー実行処理', error);
    } catch (notifyErr) {
      console.error('❌ エラーアラートの送信自体に失敗しました:', notifyErr.message);
    }

    process.exit(1);
  }
})();
