/**
 * 利用・返済状況 Webアプリケーション
 * Googleスプレッドシート CSVデータ連携 & パース・可視化ロジック
 * 
 * - LocalStorageキャッシュ & バックグラウンド差分更新（高速化）
 * - 初回アクセス時ローディングサークル待機
 * - 超過利息発生中および発生1週間前予告時の2段仕様デザイン（カウントダウンは日数のみ）
 */

// Googleスプレッドシートの公開CSV URL
const CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQVCYqe59Zkq1-9vhu1MX_O8jnL84l_zAvUsyEAc5qrb6gUXG5LdoMYl3RLYSq19qAfeY7bawrSg1wb/pub?gid=1628160295&single=true&output=csv';

// LocalStorageのキー定義
const STORAGE_KEYS = {
  CSV_DATA: 'debt_management_csv_data',
  LAST_SYNC: 'debt_management_last_sync'
};

// アプリケーションの状態管理オブジェクト
const state = {
  summary: {
    totalUsed: 0,
    totalRepaid: 0,
    principalRepaid: 0,
    interestRepaid: 0,
    balance: 0,
    totalInterest: 0,
    totalOverdueInterest: 0,
    repayRate: 0,
    tomorrowInterest: 0,
    tomorrowNormalInterest: 0,
    tomorrowOverdueInterest: 0,
    exemptionDays: '0',
    exemptionAmount: 0,
    normalInterestRate: '20.00%',
    overdueInterestRate: '29.40%',
    isTwoTier: false, // 2段仕様表示フラグ（超過利息発生中、または1週間前予告時）
    hasOverdue: false, // 実際の期限超過分が存在するかどうか
    isWarningPreview: false, // 超過利息発生1週間前予告中かどうか
    overdueInfo: null, // 上段ブロック情報
    upcomingInfo: null, // 下段ブロック情報
    nextDue: {
      date: '-',
      amount: 0,
      countdown: '--',
      countdownClass: ''
    }
  },
  usageList: [],
  repaymentList: [],
  filteredUsageList: [],
  activeTab: 'usage',
  selectedStores: new Set(),
  allStores: [],
  sortOrder: 'date-asc', // デフォルト: 古い順
  searchQuery: '',
  hasShownInitialModal: false, // ページ初期ロード時のポップアップ表示判定フラグ
  charts: {
    store: null,
    monthly: null
  }
};

// DOM要素の読み込み完了時に初期化
document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

/**
 * アプリケーションの初期化
 * LocalStorageキャッシュの即時描画 & バックグラウンド差分更新
 */
function initApp() {
  setupEventListeners();

  // LocalStorageから前回キャッシュデータの読み込みを試行
  const cachedCsv = localStorage.getItem(STORAGE_KEYS.CSV_DATA);
  const cachedSyncTime = localStorage.getItem(STORAGE_KEYS.LAST_SYNC);

  if (cachedCsv) {
    // キャッシュが存在する場合: 即座にパース・描画して表示を高速化 (0ms)
    try {
      parseCSVData(cachedCsv, true);
      hideInitialLoader();
      
      if (cachedSyncTime) {
        const lastSyncEl = document.getElementById('last-sync-time');
        if (lastSyncEl) {
          lastSyncEl.textContent = `最終更新: ${cachedSyncTime} (キャッシュ)`;
        }
      }
      
      updateStatus(true, '同期確認中');
    } catch (cacheErr) {
      console.warn('キャッシュデータの復元に失敗しました:', cacheErr);
      showInitialLoader();
    }

    // バックグラウンドで最新データを取得し、差異があれば更新
    fetchData(true);
  } else {
    // 初回アクセス時などキャッシュが存在しない場合: ローディングサークルを表示して取得待機
    showInitialLoader();
    fetchData(false);
  }
  
  // 5分ごとの自動データ更新タイマー設定
  setInterval(() => {
    fetchData(true);
  }, 5 * 60 * 1000);
}

/**
 * 初回ローディングサークルの表示
 */
function showInitialLoader() {
  const loader = document.getElementById('initial-loader');
  if (loader) {
    loader.classList.remove('hidden', 'fade-out');
  }
}

/**
 * 初回ローディングサークルの非表示（フェードアウト）
 */
function hideInitialLoader() {
  const loader = document.getElementById('initial-loader');
  if (loader && !loader.classList.contains('hidden')) {
    loader.classList.add('fade-out');
    setTimeout(() => {
      loader.classList.add('hidden');
    }, 300);
  }
}

/**
 * イベントリスナーの登録
 */
function setupEventListeners() {
  // 手動更新ボタン
  const refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      fetchData(false);
    });
  }

  // アラート閉じボタン
  const alertCloseBtn = document.getElementById('alert-close-btn');
  if (alertCloseBtn) {
    alertCloseBtn.addEventListener('click', () => {
      hideAlert();
    });
  }

  // タブ切り替えボタン
  const tabUsage = document.getElementById('tab-usage');
  const tabRepayment = document.getElementById('tab-repayment');
  if (tabUsage && tabRepayment) {
    tabUsage.addEventListener('click', () => switchTab('usage'));
    tabRepayment.addEventListener('click', () => switchTab('repayment'));
  }

  // 検索インプット
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      state.searchQuery = e.target.value.trim().toLowerCase();
      applyFilters();
    });
  }

  // 店舗全選択/全解除ボタン
  const toggleAllBtn = document.getElementById('store-toggle-all-btn');
  if (toggleAllBtn) {
    toggleAllBtn.addEventListener('click', () => {
      toggleAllStores();
    });
  }

  // ソート選択
  const sortSelect = document.getElementById('sort-select');
  if (sortSelect) {
    sortSelect.value = state.sortOrder;
    sortSelect.addEventListener('change', (e) => {
      state.sortOrder = e.target.value;
      applyFilters();
    });
  }

  // 直近返済期限ポップアップの閉じるボタン
  const modalCloseBtn = document.getElementById('modal-close-btn');
  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', () => {
      hideDueModal();
    });
  }

  // モーダル背景オーバーレイのクリックで閉じる
  const modalOverlay = document.getElementById('due-modal-overlay');
  if (modalOverlay) {
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) {
        hideDueModal();
      }
    });
  }

  // ESCキー押下でモーダルを閉じる
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideDueModal();
    }
  });

  // サマリーカード「直近の返済期限」クリックでモーダル再表示
  const kpiCardDue = document.getElementById('kpi-card-due');
  if (kpiCardDue) {
    kpiCardDue.addEventListener('click', () => {
      showDueModal();
    });
  }

  // ウィンドウリサイズ時にスクロールヒント判定を再実行
  window.addEventListener('resize', () => {
    checkScrollHint('usage-table-container', 'usage-scroll-hint');
    checkScrollHint('repayment-table-container', 'repayment-scroll-hint');
  });
}

/**
 * GoogleスプレッドシートのCSVデータを非同期取得
 * @param {boolean} isBackground - バックグラウンド更新かどうか
 */
async function fetchData(isBackground = false) {
  updateStatus(true, '更新中');
  if (!isBackground) {
    showAlert('info', '更新中', '最新のデータを取得しています');
  }

  try {
    const response = await fetch(CSV_URL, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`HTTPステータス: ${response.status}`);
    }
    const csvText = await response.text();
    
    // LocalStorageに保存されている前回のCSVデータと比較
    const cachedCsv = localStorage.getItem(STORAGE_KEYS.CSV_DATA);
    const isDifferent = cachedCsv !== csvText;

    const now = new Date();
    const timeString = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    if (isDifferent || !cachedCsv) {
      // 差異がある場合、または初回取得時はLocalStorageを更新して画面再描画
      localStorage.setItem(STORAGE_KEYS.CSV_DATA, csvText);
      localStorage.setItem(STORAGE_KEYS.LAST_SYNC, timeString);
      
      parseCSVData(csvText, false);
      
      if (isBackground && cachedCsv) {
        showAlert('success', '更新完了', 'バックグラウンドで最新データを反映しました');
      } else if (!isBackground) {
        showAlert('success', '完了', 'データを正常に読み込みました');
      }
    } else {
      // 差異がない場合は再描画によるチラつきを防ぎ、同期ステータスのみ最新化
      localStorage.setItem(STORAGE_KEYS.LAST_SYNC, timeString);
      if (!isBackground) {
        showAlert('success', '完了', 'データは既に最新の状態です');
      }
    }

    updateStatus(false, '同期完了');
    
    // 更新日時表示
    const lastSyncEl = document.getElementById('last-sync-time');
    if (lastSyncEl) {
      lastSyncEl.textContent = `最終更新: ${timeString}`;
    }

  } catch (error) {
    console.error('データ取得エラー:', error);
    updateStatus(false, '取得失敗');
    
    const cachedCsv = localStorage.getItem(STORAGE_KEYS.CSV_DATA);
    if (cachedCsv) {
      showAlert('warning', 'オフライン表示', `最新のデータ取得に失敗したため前回の保存データを表示しています: ${error.message}`);
    } else {
      showAlert('error', 'エラー', `データの取得に失敗しました: ${error.message}`);
    }
  } finally {
    // 初回ローディングサークルを終了
    hideInitialLoader();
  }
}

/**
 * CSVテキストをパースしてデータオブジェクトを生成
 * @param {string} csvText - 取得したCSV文字列
 * @param {boolean} isInitialRender - キャッシュ等による初期描画かどうか
 */
function parseCSVData(csvText, isInitialRender = false) {
  const lines = csvText.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
  
  state.usageList = [];
  state.repaymentList = [];

  let summaryFound = false;

  // 明細カラムの動的マッピング用変数
  let detailColMap = {
    usageDate: 0,
    dueDate: 1,
    store: 2,
    amount: 3,
    interestStartDate: 4,
    resolvedAmount: 5,
    interest: 6,
    overdueInterest: 7,
    balanceTotal: 8,
    isPaid: 9,
    repayDate: 10,
    repayAmount: 11
  };

  for (let i = 0; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    
    // サマリー行の解析 (「総利用額」が含まれるヘッダー行を検出)
    if (cols.includes('総利用額')) {
      const nextLine = lines[i + 1] ? parseCSVLine(lines[i + 1]) : [];
      
      const idxNormalRate = cols.indexOf('金利');
      const idxOverdueRate = cols.indexOf('超過金利');
      const idxTotalUsed = cols.indexOf('総利用額');
      const idxPrincipalRepaid = cols.indexOf('元金返済額');
      const idxBalance = cols.indexOf('残額');
      const idxInterest = cols.indexOf('利息合計');
      const idxOverdueInterest = cols.indexOf('超過利息合計');
      const idxRepayRate = cols.indexOf('返済率');
      const idxTomorrow = cols.indexOf('明日の利息');
      const idxExemption = cols.indexOf('免除ルール(日数)');
      const idxAmount = cols.indexOf('金額');

      // 金利の取得
      if (idxNormalRate !== -1 && nextLine[idxNormalRate] !== undefined && nextLine[idxNormalRate] !== '') {
        state.summary.normalInterestRate = nextLine[idxNormalRate];
      }
      if (idxOverdueRate !== -1 && nextLine[idxOverdueRate] !== undefined && nextLine[idxOverdueRate] !== '') {
        state.summary.overdueInterestRate = nextLine[idxOverdueRate];
      }

      // 総利用額 (D2)
      if (idxTotalUsed !== -1 && nextLine[idxTotalUsed] !== undefined) {
        state.summary.totalUsed = parseNumber(nextLine[idxTotalUsed]);
      }
      
      // 免除ルールの対象金額（スプレッドシートの「金額」列）
      if (idxAmount !== -1 && nextLine[idxAmount] !== undefined && nextLine[idxAmount] !== '') {
        state.summary.exemptionAmount = parseNumber(nextLine[idxAmount]);
      } else {
        state.summary.exemptionAmount = 2000;
      }

      // 元金返済額（スプレッドシートの「元金返済額」列）
      if (idxPrincipalRepaid !== -1 && nextLine[idxPrincipalRepaid] !== undefined) {
        state.summary.principalRepaid = parseNumber(nextLine[idxPrincipalRepaid]);
      }

      // 残額
      if (idxBalance !== -1 && nextLine[idxBalance] !== undefined) {
        state.summary.balance = parseNumber(nextLine[idxBalance]);
      }

      // 利息合計 (G2)
      if (idxInterest !== -1 && nextLine[idxInterest] !== undefined) {
        state.summary.totalInterest = parseNumber(nextLine[idxInterest]);
      }

      // 超過利息合計 (H2)
      if (idxOverdueInterest !== -1 && nextLine[idxOverdueInterest] !== undefined) {
        state.summary.totalOverdueInterest = parseNumber(nextLine[idxOverdueInterest]);
      }

      // 初期値としての総返済額（返済履歴明細の合計で確定）
      state.summary.totalRepaid = state.summary.principalRepaid;
      state.summary.interestRepaid = 0;

      // 返済率
      if (idxRepayRate !== -1 && nextLine[idxRepayRate] !== undefined) {
        const rateStr = nextLine[idxRepayRate] || '0';
        state.summary.repayRate = parseFloat(rateStr.replace('%', '')) || 0;
      }

      // 明日の利息
      if (idxTomorrow !== -1 && nextLine[idxTomorrow] !== undefined) {
        state.summary.tomorrowInterest = parseNumber(nextLine[idxTomorrow]);
      }

      // 免除ルール(日数)
      if (idxExemption !== -1 && nextLine[idxExemption] !== undefined) {
        state.summary.exemptionDays = nextLine[idxExemption] || '0';
      }

      summaryFound = true;
    }

    // 明細ヘッダー行の検出 (動的にカラム位置を取得)
    if (cols.includes('利用日')) {
      detailColMap.usageDate = cols.indexOf('利用日');
      detailColMap.dueDate = cols.indexOf('返済期限');
      detailColMap.store = cols.indexOf('利用店舗');
      detailColMap.amount = cols.indexOf('利用額');
      detailColMap.interestStartDate = cols.indexOf('利息発生日');
      detailColMap.resolvedAmount = cols.indexOf('解消済額');
      detailColMap.interest = cols.indexOf('利息');
      detailColMap.overdueInterest = cols.indexOf('超過利息');
      detailColMap.balanceTotal = cols.indexOf('残額計');
      detailColMap.isPaid = cols.indexOf('返済済み');
      detailColMap.repayDate = cols.indexOf('返済日');
      detailColMap.repayAmount = cols.indexOf('返済額');
      continue;
    }

    // 利用明細のパース
    const usageDateIdx = detailColMap.usageDate !== -1 ? detailColMap.usageDate : 0;
    const dueDateIdx = detailColMap.dueDate !== -1 ? detailColMap.dueDate : 1;
    const storeIdx = detailColMap.store !== -1 ? detailColMap.store : 2;
    const amountIdx = detailColMap.amount !== -1 ? detailColMap.amount : 3;

    if (cols[usageDateIdx] && cols[usageDateIdx] !== '利用日' && isDate(cols[usageDateIdx])) {
      const usageDate = cols[usageDateIdx];
      const dueDate = cols[dueDateIdx] && isDate(cols[dueDateIdx]) ? cols[dueDateIdx] : (cols[dueDateIdx] || '-');
      const storeName = cols[storeIdx] || '不明';
      const usageAmount = parseNumber(cols[amountIdx]);
      
      // 各行の返済状況（解消済額・通常利息・超過利息・残額計・返済済み）の取得
      const resolvedVal = detailColMap.resolvedAmount !== -1 ? cols[detailColMap.resolvedAmount] : '';
      const resolved = parseNumber(resolvedVal);
      
      const normalInterestVal = detailColMap.interest !== -1 ? cols[detailColMap.interest] : '';
      const normalInterest = parseNumber(normalInterestVal);

      const overdueInterestVal = detailColMap.overdueInterest !== -1 ? cols[detailColMap.overdueInterest] : '';
      const overdueInterest = parseNumber(overdueInterestVal);

      const balanceVal = detailColMap.balanceTotal !== -1 ? cols[detailColMap.balanceTotal] : '';
      const balance = parseNumber(balanceVal);

      const isPaidStr = detailColMap.isPaid !== -1 && cols[detailColMap.isPaid] ? String(cols[detailColMap.isPaid]).trim().toUpperCase() : '';
      const isPaid = isPaidStr === 'TRUE';

      // ステータス判定（返済済、一部返済済み、未納）
      let statusText = '未納';
      let statusKey = 'unpaid';

      if (isPaid || balance === 0 || (resolved >= usageAmount && resolved > 0)) {
        statusText = '返済済';
        statusKey = 'paid';
      } else if (resolved > 0) {
        statusText = '一部返済済み';
        statusKey = 'partial';
      } else {
        statusText = '未納';
        statusKey = 'unpaid';
      }

      if (usageAmount > 0) {
        state.usageList.push({
          id: `usage-${state.usageList.length}`,
          date: usageDate,
          dueDate: dueDate,
          store: storeName,
          amount: usageAmount,
          resolvedAmount: resolved,
          interest: normalInterest,
          overdueInterest: overdueInterest,
          balance: balance,
          status: {
            text: statusText,
            key: statusKey
          }
        });
      }
    }

    // 返済明細のパース
    const repayDateIdx = detailColMap.repayDate !== -1 ? detailColMap.repayDate : 10;
    const repayAmountIdx = detailColMap.repayAmount !== -1 ? detailColMap.repayAmount : 11;

    if (cols[repayDateIdx] && cols[repayDateIdx] !== '返済日' && isDate(cols[repayDateIdx])) {
      const repayDate = cols[repayDateIdx];
      const repayAmount = parseNumber(cols[repayAmountIdx]);
      
      if (repayAmount > 0) {
        state.repaymentList.push({
          id: `repay-${state.repaymentList.length}`,
          date: repayDate,
          amount: repayAmount
        });
      }
    }
  }

  // 返済履歴明細から正確な総返済額および利息返済額を算出
  const actualRepaidTotal = state.repaymentList.reduce((sum, item) => sum + item.amount, 0);
  if (actualRepaidTotal > 0) {
    state.summary.totalRepaid = actualRepaidTotal;
    // 利息返済額 = 総返済額 - 元金返済額 (0以上)
    state.summary.interestRepaid = Math.max(0, actualRepaidTotal - state.summary.principalRepaid);
  }

  // 万一サマリー行が見つからなかった場合の動的フォールバック計算
  if (!summaryFound) {
    const calcUsed = state.usageList.reduce((sum, item) => sum + item.amount, 0);
    const calcRepaid = state.repaymentList.reduce((sum, item) => sum + item.amount, 0);
    state.summary.totalUsed = calcUsed;
    state.summary.totalRepaid = calcRepaid;
    state.summary.principalRepaid = calcRepaid;
    state.summary.interestRepaid = 0;
    state.summary.balance = calcUsed - calcRepaid;
    state.summary.repayRate = calcUsed > 0 ? (calcRepaid / calcUsed) * 100 : 0;
  }

  // 直近の返済期限および超過分・予告の集計（2段仕様判定）
  calculateNextDueDate();

  // 店舗リストの取得と全選択初期化
  state.allStores = [...new Set(state.usageList.map(item => item.store))];
  state.selectedStores = new Set(state.allStores);

  // チェックボックスUIの生成
  populateStoreCheckboxes();

  // 画面の各領域を描画
  renderKPI();
  renderCharts();
  applyFilters();
  renderRepaymentTable();

  // ページを開いた初回のみ、直近の返済期限ポップアップを表示
  if (!state.hasShownInitialModal) {
    showDueModal();
    state.hasShownInitialModal = true;
  }
}

/**
 * 直近の返済期限と超過分、および超過利息予告（2段仕様、日数のみ）を計算
 */
function calculateNextDueDate() {
  // 未完済かつ有効な期限が存在する明細を抽出
  const unpaidItems = state.usageList.filter(item => 
    item.status.key !== 'paid' && 
    item.dueDate && 
    item.dueDate !== '-' && 
    isDate(item.dueDate)
  );

  if (unpaidItems.length === 0) {
    state.summary.isTwoTier = false;
    state.summary.hasOverdue = false;
    state.summary.isWarningPreview = false;
    state.summary.overdueInfo = null;
    state.summary.upcomingInfo = null;
    state.summary.nextDue = {
      date: '完済済',
      amount: 0,
      countdown: '未納なし',
      countdownClass: ''
    };
    return;
  }

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // 各明細の期日との差分日数を計算
  const itemsWithDiff = unpaidItems.map(item => {
    const parts = item.dueDate.split(/[\/\-]/);
    const targetDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    const diffTime = targetDate.getTime() - today.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    return {
      ...item,
      targetDate,
      diffDays
    };
  });

  // 超過分 (diffDays < 0: 返済期限の翌日以降)
  const overdueItems = itemsWithDiff.filter(item => item.diffDays < 0);
  // 次回以降分 (diffDays >= 0: 本日以降が期日)
  const upcomingItems = itemsWithDiff.filter(item => item.diffDays >= 0);

  // 【ケース1: 超過利息発生中（超過分が存在する場合）】
  if (overdueItems.length > 0) {
    state.summary.hasOverdue = true;
    state.summary.isWarningPreview = false;

    // 期限日が古い順（最も超過日数が長い順）にソート
    overdueItems.sort((a, b) => a.targetDate.getTime() - b.targetDate.getTime());
    
    const earliestOverdueDate = overdueItems[0].dueDate;
    const overdueTotalAmount = overdueItems.reduce((sum, item) => sum + (item.balance > 0 ? item.balance : item.amount), 0);
    const maxOverdueDays = Math.abs(overdueItems[0].diffDays);

    state.summary.overdueInfo = {
      title: '期限超過分',
      date: earliestOverdueDate,
      amount: overdueTotalAmount,
      days: maxOverdueDays,
      text: `${maxOverdueDays}日 超過`,
      badgeClass: 'overdue'
    };

    if (upcomingItems.length > 0) {
      upcomingItems.sort((a, b) => a.targetDate.getTime() - b.targetDate.getTime());
      const nextDueDate = upcomingItems[0].dueDate;
      const nextDiffDays = upcomingItems[0].diffDays;
      const targetNextItems = upcomingItems.filter(item => item.dueDate === nextDueDate);
      const nextTotalAmount = targetNextItems.reduce((sum, item) => sum + (item.balance > 0 ? item.balance : item.amount), 0);

      let countdownText = '';
      let countdownClass = '';
      if (nextDiffDays > 3) {
        countdownText = `あと ${nextDiffDays} 日`;
        countdownClass = '';
      } else if (nextDiffDays > 0) {
        countdownText = `あと ${nextDiffDays} 日`;
        countdownClass = 'imminent';
      } else {
        countdownText = '本日が期日';
        countdownClass = 'overdue';
      }

      state.summary.upcomingInfo = {
        title: '次回期限分',
        date: nextDueDate,
        amount: nextTotalAmount,
        days: nextDiffDays,
        text: countdownText,
        badgeClass: countdownClass
      };

      state.summary.isTwoTier = true;
    } else {
      state.summary.upcomingInfo = null;
      state.summary.isTwoTier = false;
    }

  // 【ケース2: 超過分はなく、直近期日が1週間前予告期間（diffDays <= 7）の場合】
  // 超過利息発生中と同じデザイン（２段仕様）とし、カウントダウンも日数のみで表示
  } else if (upcomingItems.length > 0) {
    state.summary.hasOverdue = false;
    upcomingItems.sort((a, b) => a.targetDate.getTime() - b.targetDate.getTime());

    // ユニークな期日一覧を取得
    const uniqueDates = [...new Set(upcomingItems.map(item => item.dueDate))];
    const firstDate = uniqueDates[0];
    const firstItems = upcomingItems.filter(item => item.dueDate === firstDate);
    const firstAmount = firstItems.reduce((sum, item) => sum + (item.balance > 0 ? item.balance : item.amount), 0);
    const firstDiffDays = firstItems[0].diffDays;

    // 直近期日が7日以内の場合は超過利息発生予告として2段仕様にする
    if (firstDiffDays <= 7) {
      state.summary.isTwoTier = true;
      state.summary.isWarningPreview = true;

      const firstCountdownText = firstDiffDays === 0 ? '本日が期日' : `あと ${firstDiffDays} 日`;

      // 上の段: 直近期限分 (超過利息発生中と同じデザイン、警告赤バッジ)
      state.summary.overdueInfo = {
        title: '直近期限分',
        date: firstDate,
        amount: firstAmount,
        days: firstDiffDays,
        text: firstCountdownText,
        badgeClass: 'overdue' // 超過利息発生中と同様の赤バッジで目立たせる
      };

      // 下の段: 次回期限分（第2の期日がある場合）
      if (uniqueDates.length > 1) {
        const secondDate = uniqueDates[1];
        const secondItems = upcomingItems.filter(item => item.dueDate === secondDate);
        const secondAmount = secondItems.reduce((sum, item) => sum + (item.balance > 0 ? item.balance : item.amount), 0);
        const secondDiffDays = secondItems[0].diffDays;

        state.summary.upcomingInfo = {
          title: '次回期限分',
          date: secondDate,
          amount: secondAmount,
          days: secondDiffDays,
          text: `あと ${secondDiffDays} 日`,
          badgeClass: ''
        };
      } else {
        // 次回の期日がない場合
        state.summary.upcomingInfo = {
          title: '次回期限分',
          date: '未定',
          amount: 0,
          days: 0,
          text: '次回なし',
          badgeClass: ''
        };
      }
    } else {
      // 8日以上の平常時は1段表示
      state.summary.isTwoTier = false;
      state.summary.isWarningPreview = false;
      state.summary.overdueInfo = null;
      state.summary.upcomingInfo = null;
    }

    state.summary.nextDue = {
      date: firstDate,
      amount: firstAmount,
      countdown: `あと ${firstDiffDays} 日`,
      countdownClass: firstDiffDays <= 3 ? 'imminent' : ''
    };

  } else {
    state.summary.isTwoTier = false;
    state.summary.hasOverdue = false;
    state.summary.isWarningPreview = false;
    state.summary.overdueInfo = null;
    state.summary.upcomingInfo = null;
  }

  // 1段表示用フォールバック
  if (state.summary.hasOverdue && state.summary.overdueInfo) {
    state.summary.nextDue = {
      date: state.summary.overdueInfo.date,
      amount: state.summary.overdueInfo.amount,
      countdown: state.summary.overdueInfo.text,
      countdownClass: 'overdue'
    };
  }

  // 明日の利息の内訳計算（通常分・超過分）
  calculateTomorrowInterestBreakdown(overdueItems, upcomingItems);
}

/**
 * 明日の利息の内訳（通常利息・超過利息）を計算
 */
function calculateTomorrowInterestBreakdown(overdueItems, upcomingItems) {
  const normalRateNum = parseFloat(state.summary.normalInterestRate.replace('%', '')) / 100 || 0.20;
  const overdueRateNum = parseFloat(state.summary.overdueInterestRate.replace('%', '')) / 100 || 0.294;

  if (overdueItems.length > 0) {
    // 超過対象の元金残高合計
    const overduePrincipalTotal = overdueItems.reduce((sum, item) => {
      const p = item.amount - item.resolvedAmount;
      return sum + (p > 0 ? p : 0);
    }, 0);

    // 1日あたりの超過利息 (日歩)
    const overduePerDay = Math.round((overduePrincipalTotal * overdueRateNum) / 365);
    state.summary.tomorrowOverdueInterest = overduePerDay > 0 ? overduePerDay : 1;

    // 通常対象の利息はスプレッドシートの明日の利息から超過分を引いた額、あるいは通常元金から算出
    if (state.summary.tomorrowInterest > state.summary.tomorrowOverdueInterest) {
      state.summary.tomorrowNormalInterest = state.summary.tomorrowInterest - state.summary.tomorrowOverdueInterest;
    } else {
      const upcomingPrincipalTotal = upcomingItems.reduce((sum, item) => {
        const p = item.amount - item.resolvedAmount;
        return sum + (p > 0 ? p : 0);
      }, 0);
      state.summary.tomorrowNormalInterest = Math.round((upcomingPrincipalTotal * normalRateNum) / 365);
    }
  } else {
    state.summary.tomorrowNormalInterest = state.summary.tomorrowInterest;
    state.summary.tomorrowOverdueInterest = 0;
  }
}

/**
 * 直近の返済期限ポップアップ（M3 Dialog）を表示
 * 超過利息発生中および発生1週間前予告時は2段仕様で統一
 */
function showDueModal() {
  const modalOverlay = document.getElementById('due-modal-overlay');
  const modalSingle = document.getElementById('modal-body-single');
  const modalMulti = document.getElementById('modal-body-multi');
  const modalCountdown = document.getElementById('modal-due-countdown');

  if (!modalOverlay) return;

  const { isTwoTier, overdueInfo, upcomingInfo, nextDue } = state.summary;

  if (isTwoTier && overdueInfo && upcomingInfo) {
    // 2段表示
    if (modalSingle) modalSingle.classList.add('hidden');
    if (modalMulti) modalMulti.classList.remove('hidden');

    // 2段表示時は全体の右上のカウントダウンバッジは非表示
    if (modalCountdown) {
      modalCountdown.style.display = 'none';
    }

    // 上の段: 期限超過分 / 直近期限分
    const elOverdueTitle = document.getElementById('modal-tier-overdue-title');
    const elOverdueDate = document.getElementById('modal-tier-overdue-date');
    const elOverdueAmount = document.getElementById('modal-tier-overdue-amount');
    const elOverdueCountdown = document.getElementById('modal-tier-overdue-countdown');

    if (elOverdueTitle) elOverdueTitle.textContent = overdueInfo.title || '期限超過分';
    if (elOverdueDate) elOverdueDate.textContent = overdueInfo.date;
    if (elOverdueAmount) elOverdueAmount.textContent = `¥${overdueInfo.amount.toLocaleString()}`;
    if (elOverdueCountdown) {
      elOverdueCountdown.textContent = overdueInfo.text;
      elOverdueCountdown.className = `countdown-tag ${overdueInfo.badgeClass || 'overdue'}`.trim();
    }

    // 下の段: 次回期限分
    const elUpcomingTitle = document.getElementById('modal-tier-upcoming-title');
    const elUpcomingDate = document.getElementById('modal-tier-upcoming-date');
    const elUpcomingAmount = document.getElementById('modal-tier-upcoming-amount');
    const elUpcomingCountdown = document.getElementById('modal-tier-upcoming-countdown');

    if (elUpcomingTitle) elUpcomingTitle.textContent = upcomingInfo.title || '次回期限分';
    if (elUpcomingDate) elUpcomingDate.textContent = upcomingInfo.date;
    if (elUpcomingAmount) elUpcomingAmount.textContent = upcomingInfo.amount > 0 ? `¥${upcomingInfo.amount.toLocaleString()}` : '-';
    if (elUpcomingCountdown) {
      elUpcomingCountdown.textContent = upcomingInfo.text;
      elUpcomingCountdown.className = `countdown-tag ${upcomingInfo.badgeClass || ''}`.trim();
    }

  } else {
    // 1段表示 (平常時)
    if (modalSingle) modalSingle.classList.remove('hidden');
    if (modalMulti) modalMulti.classList.add('hidden');

    const modalDueDate = document.getElementById('modal-due-date');
    const modalDueAmount = document.getElementById('modal-due-amount');

    if (modalDueDate) {
      modalDueDate.textContent = nextDue.date || '-';
    }
    if (modalDueAmount) {
      modalDueAmount.textContent = `¥${nextDue.amount.toLocaleString()}`;
    }
    if (modalCountdown) {
      modalCountdown.style.display = 'inline-flex';
      modalCountdown.textContent = nextDue.countdown || '--';
      modalCountdown.className = `countdown-tag ${nextDue.countdownClass || ''}`.trim();
    }
  }

  modalOverlay.classList.remove('hidden');
}

/**
 * 直近の返済期限ポップアップを閉じる
 */
function hideDueModal() {
  const modalOverlay = document.getElementById('due-modal-overlay');
  if (modalOverlay) {
    modalOverlay.classList.add('hidden');
  }
}

/**
 * 簡易CSV行パース関数（カンマ区切りおよびダブルクォーテーションに対応）
 * @param {string} textLine 
 */
function parseCSVLine(textLine) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  
  for (let i = 0; i < textLine.length; i++) {
    const char = textLine[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += char;
    }
  }
  result.push(cur.trim());
  return result;
}

/**
 * 数値パースヘルパー (カンマ除去対応)
 */
function parseNumber(val) {
  if (!val) return 0;
  const cleaned = String(val).replace(/,/g, '').replace(/¥/g, '').trim();
  return parseFloat(cleaned) || 0;
}

/**
 * 日付判定ヘルパー (YYYY/MM/DD または YYYY-MM-DD 形式)
 */
function isDate(val) {
  if (!val) return false;
  return /^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}$/.test(val.trim());
}

/**
 * KPIサマリーの描画
 */
function renderKPI() {
  const { 
    totalUsed, 
    totalRepaid, 
    principalRepaid, 
    interestRepaid, 
    balance, 
    totalInterest,
    totalOverdueInterest,
    repayRate, 
    tomorrowInterest, 
    tomorrowNormalInterest,
    tomorrowOverdueInterest,
    exemptionDays, 
    exemptionAmount, 
    normalInterestRate,
    overdueInterestRate,
    isTwoTier,
    hasOverdue, 
    overdueInfo, 
    upcomingInfo, 
    nextDue 
  } = state.summary;

  // 1: 総利用額 & 利息込み総返済額 (計算: D2 + G2 + H2)
  const elTotalUsed = document.getElementById('kpi-total-used');
  if (elTotalUsed) elTotalUsed.textContent = `¥${totalUsed.toLocaleString()}`;

  const elTotalWithInterest = document.getElementById('kpi-total-with-interest');
  if (elTotalWithInterest) {
    const fullRepayAmount = totalUsed + totalInterest + totalOverdueInterest;
    elTotalWithInterest.textContent = `(利息込: ¥${fullRepayAmount.toLocaleString()})`;
  }

  // 利用件数バッジ (上下中央位置)
  const elCountUsed = document.getElementById('kpi-count-used');
  if (elCountUsed) elCountUsed.textContent = `${state.usageList.length}件`;

  // 2: 総返済額
  const elTotalRepaid = document.getElementById('kpi-total-repaid');
  if (elTotalRepaid) elTotalRepaid.textContent = `¥${totalRepaid.toLocaleString()}`;
  const elPrincipal = document.getElementById('kpi-principal-repaid');
  if (elPrincipal) elPrincipal.textContent = `¥${principalRepaid.toLocaleString()}`;
  const elInterest = document.getElementById('kpi-interest-repaid');
  if (elInterest) elInterest.textContent = `¥${interestRepaid.toLocaleString()}`;

  // 3: 残額
  const elBalance = document.getElementById('kpi-balance');
  if (elBalance) elBalance.textContent = `¥${balance.toLocaleString()}`;

  // 4: 返済率
  const elRepayRate = document.getElementById('kpi-repay-rate');
  if (elRepayRate) elRepayRate.textContent = `${repayRate.toFixed(2)}%`;

  const clampedRate = Math.min(Math.max(repayRate, 0), 100);
  const progressBarFill = document.getElementById('progress-bar-fill');
  if (progressBarFill) {
    progressBarFill.style.width = `${clampedRate}%`;
  }

  // 5: 直近の返済期限 (超過利息発生中または予告時は2段表示)
  const dueSingleContainer = document.getElementById('due-single-container');
  const dueMultiContainer = document.getElementById('due-multi-container');

  if (isTwoTier && overdueInfo && upcomingInfo) {
    if (dueSingleContainer) dueSingleContainer.classList.add('hidden');
    if (dueMultiContainer) dueMultiContainer.classList.remove('hidden');

    // 上の段: 超過分 / 直近期限分 (返済額、日数、返済期限日)
    const elTierOverdueAmount = document.getElementById('kpi-tier-overdue-amount');
    const elTierOverdueDays = document.getElementById('kpi-tier-overdue-days');
    const elTierOverdueDate = document.getElementById('kpi-tier-overdue-date');

    if (elTierOverdueAmount) elTierOverdueAmount.textContent = `¥${overdueInfo.amount.toLocaleString()}`;
    if (elTierOverdueDays) {
      elTierOverdueDays.textContent = overdueInfo.text;
      elTierOverdueDays.className = `countdown-tag ${overdueInfo.badgeClass || 'overdue'}`.trim();
    }
    if (elTierOverdueDate) elTierOverdueDate.textContent = overdueInfo.date;

    // 下の段: 次の期限分 (返済額、あと何日、返済期限日)
    const elTierUpcomingAmount = document.getElementById('kpi-tier-upcoming-amount');
    const elTierUpcomingDays = document.getElementById('kpi-tier-upcoming-days');
    const elTierUpcomingDate = document.getElementById('kpi-tier-upcoming-date');

    if (elTierUpcomingAmount) elTierUpcomingAmount.textContent = upcomingInfo.amount > 0 ? `¥${upcomingInfo.amount.toLocaleString()}` : '-';
    if (elTierUpcomingDays) {
      elTierUpcomingDays.textContent = upcomingInfo.text;
      elTierUpcomingDays.className = `countdown-tag ${upcomingInfo.badgeClass || ''}`.trim();
    }
    if (elTierUpcomingDate) elTierUpcomingDate.textContent = upcomingInfo.date;

  } else {
    if (dueSingleContainer) dueSingleContainer.classList.remove('hidden');
    if (dueMultiContainer) dueMultiContainer.classList.add('hidden');

    const elDueDate = document.getElementById('kpi-due-date');
    if (elDueDate) elDueDate.textContent = nextDue.date;

    const elDueAmount = document.getElementById('kpi-due-amount');
    if (elDueAmount) elDueAmount.textContent = `¥${nextDue.amount.toLocaleString()}`;

    const elCountdown = document.getElementById('kpi-due-countdown');
    if (elCountdown) {
      elCountdown.textContent = nextDue.countdown;
      elCountdown.className = `countdown-tag ${nextDue.countdownClass}`.trim();
    }
  }

  // 6: 明日の利息予定額 (超過がある場合は2段表示で金利も表記し、超過分は利息免除対象外と明記)
  const tomorrowSingleContainer = document.getElementById('tomorrow-single-container');
  const tomorrowMultiContainer = document.getElementById('tomorrow-multi-container');

  const formattedAmount = exemptionAmount > 0 ? `¥${exemptionAmount.toLocaleString()}` : '¥2,000';
  const exemptionText = `直近${exemptionDays}日に${formattedAmount}円以上返済で免除`;

  if (hasOverdue && overdueInfo) {
    if (tomorrowSingleContainer) tomorrowSingleContainer.classList.add('hidden');
    if (tomorrowMultiContainer) tomorrowMultiContainer.classList.remove('hidden');

    const elNormalRate = document.getElementById('kpi-normal-rate');
    const elOverdueRate = document.getElementById('kpi-overdue-rate');
    const elTomorrowNormal = document.getElementById('kpi-tomorrow-normal-interest');
    const elTomorrowOverdue = document.getElementById('kpi-tomorrow-overdue-interest');
    const elExemptionMulti = document.getElementById('kpi-exemption-rule-multi');

    if (elNormalRate) elNormalRate.textContent = normalInterestRate;
    if (elOverdueRate) elOverdueRate.textContent = overdueInterestRate;
    if (elTomorrowNormal) elTomorrowNormal.textContent = `¥${tomorrowNormalInterest.toLocaleString()}`;
    if (elTomorrowOverdue) elTomorrowOverdue.textContent = `¥${tomorrowOverdueInterest.toLocaleString()}`;
    if (elExemptionMulti) elExemptionMulti.textContent = exemptionText;

  } else {
    if (tomorrowSingleContainer) tomorrowSingleContainer.classList.remove('hidden');
    if (tomorrowMultiContainer) tomorrowMultiContainer.classList.add('hidden');

    const elTomorrow = document.getElementById('kpi-tomorrow-interest');
    if (elTomorrow) elTomorrow.textContent = `¥${tomorrowInterest.toLocaleString()}`;

    const elExemption = document.getElementById('kpi-exemption-rule');
    if (elExemption) elExemption.textContent = exemptionText;
  }

  // 件数バッジ更新
  const elUsageCount = document.getElementById('usage-count');
  if (elUsageCount) elUsageCount.textContent = state.usageList.length;
  const elRepayCount = document.getElementById('repayment-count');
  if (elRepayCount) elRepayCount.textContent = state.repaymentList.length;
}

/**
 * 店舗フィルターのチェックボックス一覧生成
 */
function populateStoreCheckboxes() {
  const container = document.getElementById('store-checkbox-group');
  if (!container) return;

  container.innerHTML = '';

  state.allStores.forEach(store => {
    const isChecked = state.selectedStores.has(store);

    const label = document.createElement('label');
    label.className = 'store-checkbox-label';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = store;
    input.checked = isChecked;

    input.addEventListener('change', (e) => {
      if (e.target.checked) {
        state.selectedStores.add(store);
      } else {
        state.selectedStores.delete(store);
      }
      updateToggleAllBtn();
      applyFilters();
    });

    label.appendChild(input);
    label.appendChild(document.createTextNode(store));
    container.appendChild(label);
  });

  updateToggleAllBtn();
}

/**
 * 全選択/全解除の切り替え
 */
function toggleAllStores() {
  const allSelected = state.selectedStores.size === state.allStores.length;

  if (allSelected) {
    state.selectedStores.clear();
  } else {
    state.selectedStores = new Set(state.allStores);
  }

  // チェックボックスDOMの状態更新
  const container = document.getElementById('store-checkbox-group');
  if (container) {
    const inputs = container.querySelectorAll('input[type="checkbox"]');
    inputs.forEach(input => {
      input.checked = !allSelected;
    });
  }

  updateToggleAllBtn();
  applyFilters();
}

/**
 * 全選択/全解除ボタンのテキスト更新
 */
function updateToggleAllBtn() {
  const btn = document.getElementById('store-toggle-all-btn');
  if (!btn) return;

  if (state.selectedStores.size === state.allStores.length) {
    btn.textContent = '全解除';
  } else {
    btn.textContent = '全選択';
  }
}

/**
 * フィルター・検索・ソートの適用
 */
function applyFilters() {
  let result = [...state.usageList];

  // 店舗チェックボックスフィルター
  result = result.filter(item => state.selectedStores.has(item.store));

  // 検索クエリ
  if (state.searchQuery) {
    result = result.filter(item => 
      item.store.toLowerCase().includes(state.searchQuery) ||
      item.date.includes(state.searchQuery) ||
      (item.dueDate && item.dueDate.includes(state.searchQuery)) ||
      item.amount.toString().includes(state.searchQuery) ||
      item.status.text.includes(state.searchQuery)
    );
  }

  // ソート順 (デフォルト: 古い順 date-asc)
  result.sort((a, b) => {
    if (state.sortOrder === 'date-asc') {
      return new Date(a.date) - new Date(b.date);
    } else if (state.sortOrder === 'date-desc') {
      return new Date(b.date) - new Date(a.date);
    } else if (state.sortOrder === 'amount-desc') {
      return b.amount - a.amount;
    } else if (state.sortOrder === 'amount-asc') {
      return a.amount - b.amount;
    }
    return 0;
  });

  state.filteredUsageList = result;
  renderUsageTable();
}

/**
 * 利用明細テーブルの描画
 */
function renderUsageTable() {
  const tbody = document.getElementById('usage-table-body');
  if (!tbody) return;

  if (state.filteredUsageList.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="table-empty">該当する明細がありません</td>
      </tr>
    `;
    return;
  }

  let html = '';
  state.filteredUsageList.forEach(item => {
    // 一部返済済みの場合は返済済み額と残額を表示
    let detailHtml = '<span style="color:var(--md-sys-color-outline); font-size:0.8125rem;">-</span>';
    if (item.status.key === 'partial') {
      detailHtml = `
        <div class="partial-amount-info">
          <span class="paid-part">済: ¥${item.resolvedAmount.toLocaleString()}</span>
          <span class="slash">/</span>
          <span class="remain-part">残: ¥${item.balance.toLocaleString()}</span>
        </div>
      `;
    } else if (item.status.key === 'paid') {
      detailHtml = `<span style="color:var(--md-sys-color-success); font-weight:500; font-size:0.8125rem;">完済</span>`;
    }

    // 返済期限セルのスタイル判定（未完済かつ期日あり）
    const isOverdue = item.status.key !== 'paid' && item.dueDate && item.dueDate !== '-' && new Date(item.dueDate) < new Date();
    const dueDateClass = isOverdue ? 'due-date-cell highlight-due' : 'due-date-cell';

    html += `
      <tr>
        <td>${item.date}</td>
        <td style="font-weight:500;">${escapeHTML(item.store)}</td>
        <td class="text-right" style="font-weight:500;">
          ¥${item.amount.toLocaleString()}
        </td>
        <td>
          <span class="status-indicator-text ${item.status.key}">
            <span class="dot"></span>
            ${item.status.text}
          </span>
        </td>
        <td>
          ${detailHtml}
        </td>
        <td>
          <span class="${dueDateClass}">${item.dueDate || '-'}</span>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;

  // テーブル描画後にスクロールヒント判定
  checkScrollHint('usage-table-container', 'usage-scroll-hint');
}

/**
 * 返済履歴テーブルの描画
 */
function renderRepaymentTable() {
  const tbody = document.getElementById('repayment-table-body');
  if (!tbody) return;

  if (state.repaymentList.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="2" class="table-empty">返済履歴はありません</td>
      </tr>
    `;
    return;
  }

  let html = '';
  state.repaymentList.forEach(item => {
    html += `
      <tr>
        <td>${item.date}</td>
        <td class="text-right" style="font-weight:500; color:var(--md-sys-color-on-surface);">
          ¥${item.amount.toLocaleString()}
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;

  // テーブル描画後にスクロールヒント判定
  checkScrollHint('repayment-table-container', 'repayment-scroll-hint');
}

/**
 * Chart.js グラフのレンダリング (M3 Tonal Palette)
 */
function renderCharts() {
  renderStoreChart();
  renderMonthlyChart();
}

/**
 * 店舗別支出割合（ドーナツチャート - M3パレット）
 * 利用額の多い順に12時の向きから時計回りに配置
 */
function renderStoreChart() {
  const canvas = document.getElementById('storeChart');
  if (!canvas) return;

  const storeTotals = {};
  state.usageList.forEach(item => {
    storeTotals[item.store] = (storeTotals[item.store] || 0) + item.amount;
  });

  // 利用額の多い順にソート（降順）
  const sortedStores = Object.entries(storeTotals).sort((a, b) => b[1] - a[1]);

  const labels = sortedStores.map(entry => entry[0]);
  const data = sortedStores.map(entry => entry[1]);

  // M3の計算されたトーンカラー
  const backgroundColors = [
    '#00639b', '#51606f', '#6b5778', '#146c2e', 
    '#7c5800', '#ba1a1a', '#006874', '#49454f'
  ];

  if (state.charts.store) {
    state.charts.store.destroy();
  }

  state.charts.store = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: labels,
      datasets: [{
        data: data,
        backgroundColor: backgroundColors.slice(0, labels.length),
        borderWidth: 2,
        borderColor: '#fdfcff'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      rotation: 0,
      circumference: 360,
      plugins: {
        legend: {
          position: 'right',
          labels: {
            color: '#49454f',
            font: {
              family: "'Roboto', 'Noto Sans JP', sans-serif",
              size: 11
            },
            boxWidth: 12,
            padding: 10
          }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              const label = context.label || '';
              const value = context.raw || 0;
              const total = context.chart.data.datasets[0].data.reduce((a, b) => a + b, 0);
              const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
              return `${label}: ¥${value.toLocaleString()} (${percentage}%)`;
            }
          }
        }
      },
      cutout: '70%'
    }
  });
}

/**
 * 月別推移（複合グラフ - 利用額・返済額の棒グラフ + 残額推移の折れ線グラフ）
 */
function renderMonthlyChart() {
  const canvas = document.getElementById('monthlyChart');
  if (!canvas) return;

  // 月ごとの利用額集計
  const usageTotals = {};
  state.usageList.forEach(item => {
    const parts = item.date.split('/');
    if (parts.length >= 2) {
      const monthKey = `${parts[0]}/${parts[1]}`;
      usageTotals[monthKey] = (usageTotals[monthKey] || 0) + item.amount;
    }
  });

  // 月ごとの返済額（入金）集計
  const repaymentTotals = {};
  state.repaymentList.forEach(item => {
    const parts = item.date.split('/');
    if (parts.length >= 2) {
      const monthKey = `${parts[0]}/${parts[1]}`;
      repaymentTotals[monthKey] = (repaymentTotals[monthKey] || 0) + item.amount;
    }
  });

  // 全ての月（利用または返済が存在する月）を抽出して昇順ソート
  const rawMonths = [...new Set([...Object.keys(usageTotals), ...Object.keys(repaymentTotals)])].sort();

  // 動きが無かった月（利用も返済もなかった月）も含めて最古の月から最新月まで連続して生成
  let allMonths = [];
  if (rawMonths.length > 0) {
    const [startYearStr, startMonthStr] = rawMonths[0].split('/');
    const [lastYearStr, lastMonthStr] = rawMonths[rawMonths.length - 1].split('/');

    let startYear = parseInt(startYearStr, 10);
    let startMonth = parseInt(startMonthStr, 10);

    let endYear = parseInt(lastYearStr, 10);
    let endMonth = parseInt(lastMonthStr, 10);

    // 現在日時の月も範囲に含める（直近で動きが無かった月も表示するため）
    const now = new Date();
    const curYear = now.getFullYear();
    const curMonth = now.getMonth() + 1;

    if (curYear > endYear || (curYear === endYear && curMonth > endMonth)) {
      endYear = curYear;
      endMonth = curMonth;
    }

    let y = startYear;
    let m = startMonth;

    while (y < endYear || (y === endYear && m <= endMonth)) {
      allMonths.push(`${y}/${String(m).padStart(2, '0')}`);
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }
  }

  const usageData = allMonths.map(m => usageTotals[m] || 0);
  const repaymentData = allMonths.map(m => repaymentTotals[m] || 0);

  // 各月末時点での累計残額推移の計算（動きが無かった月も前月の残額を維持して推移）
  let cumulativeUsed = 0;
  let cumulativeRepaid = 0;
  const balanceData = allMonths.map(m => {
    cumulativeUsed += (usageTotals[m] || 0);
    cumulativeRepaid += (repaymentTotals[m] || 0);
    return Math.max(0, cumulativeUsed - cumulativeRepaid);
  });

  if (state.charts.monthly) {
    state.charts.monthly.destroy();
  }

  state.charts.monthly = new Chart(canvas, {
    data: {
      labels: allMonths,
      datasets: [
        {
          type: 'line',
          label: '残額推移',
          data: balanceData,
          borderColor: '#ba1a1a',
          backgroundColor: '#ba1a1a',
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: '#ba1a1a',
          tension: 0.15,
          order: 1
        },
        {
          type: 'bar',
          label: '利用額',
          data: usageData,
          backgroundColor: '#00639b',
          borderRadius: 4,
          maxBarThickness: 22,
          order: 2
        },
        {
          type: 'bar',
          label: '返済額（入金）',
          data: repaymentData,
          backgroundColor: '#146c2e',
          borderRadius: 4,
          maxBarThickness: 22,
          order: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: 'top',
          align: 'end',
          labels: {
            color: '#49454f',
            font: {
              family: "'Roboto', 'Noto Sans JP', sans-serif",
              size: 11
            },
            boxWidth: 12,
            padding: 10
          }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              const datasetLabel = context.dataset.label || '';
              return `${datasetLabel}: ¥${(context.raw || 0).toLocaleString()}`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            display: false
          },
          ticks: {
            autoSkip: false,
            color: '#79747e',
            font: {
              family: "'Roboto', 'Noto Sans JP', sans-serif",
              size: 11
            }
          }
        },
        y: {
          grid: {
            color: '#e6e0e9',
            drawBorder: false
          },
          ticks: {
            color: '#79747e',
            font: {
              family: "'Roboto', 'Noto Sans JP', sans-serif",
              size: 11
            },
            callback: function(val) {
              return '¥' + val.toLocaleString();
            }
          }
        }
      }
    }
  });
}

/**
 * タブ切り替え処理
 * @param {'usage' | 'repayment'} tabName 
 */
function switchTab(tabName) {
  state.activeTab = tabName;

  const tabUsage = document.getElementById('tab-usage');
  const tabRepayment = document.getElementById('tab-repayment');
  const contentUsage = document.getElementById('content-usage');
  const contentRepayment = document.getElementById('content-repayment');
  const usageControls = document.getElementById('usage-controls');

  if (tabName === 'usage') {
    tabUsage.classList.add('active');
    tabRepayment.classList.remove('active');
    contentUsage.classList.add('active');
    contentRepayment.classList.remove('active');
    if (usageControls) usageControls.style.display = 'block';
  } else {
    tabUsage.classList.remove('active');
    tabRepayment.classList.add('active');
    contentUsage.classList.remove('active');
    contentRepayment.classList.add('active');
    if (usageControls) usageControls.style.display = 'none';
  }
}

/**
 * ヘッダーの同期ステータス表示更新
 */
function updateStatus(isLoading, text) {
  const dot = document.querySelector('.status-dot');
  const label = document.getElementById('status-label');

  if (label) label.textContent = text;
  if (dot) {
    if (isLoading) {
      dot.style.backgroundColor = 'var(--md-sys-color-warning)';
    } else {
      dot.style.backgroundColor = 'var(--md-sys-color-success)';
    }
  }
}

/**
 * インライン通知メッセージの表示 (ポップアップalertを使用しないルール)
 */
function showAlert(type, title, message) {
  const alertEl = document.getElementById('inline-alert');
  const titleEl = document.getElementById('alert-title');
  const messageEl = document.getElementById('alert-message');

  if (!alertEl || !titleEl || !messageEl) return;

  alertEl.className = `inline-alert ${type}`;
  titleEl.textContent = title;
  messageEl.textContent = message;

  // 成功または情報メッセージは4秒後に自動消去
  if (type === 'success' || type === 'info') {
    setTimeout(() => {
      hideAlert();
    }, 4000);
  }
}

/**
 * インライン通知メッセージの非表示
 */
function hideAlert() {
  const alertEl = document.getElementById('inline-alert');
  if (alertEl) {
    alertEl.classList.add('hidden');
  }
}

/**
 * HTMLサニタイズヘルパー
 */
function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * テーブルの横スクロールが必要かどうかを判定し、必要な場合のみスクロールヒントを表示
 * @param {string} containerId - テーブルコンテナのID
 * @param {string} hintId - スクロールヒント要素のID
 */
function checkScrollHint(containerId, hintId) {
  const container = document.getElementById(containerId);
  const hint = document.getElementById(hintId);
  if (!container || !hint) return;

  // 横スクロールが必要かどうか判定（テーブル内容がコンテナの幅を超えている場合）
  const needsScroll = container.scrollWidth > container.clientWidth + 2;

  if (needsScroll) {
    hint.classList.add('visible');
  } else {
    hint.classList.remove('visible');
  }
}
