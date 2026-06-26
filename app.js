/**
 * ═══════════════════════════════════════════════════════
 *  FX JOURNAL — app.js
 *  Offline-first Forex Trading Journal PWA
 *
 *  Architecture:
 *   - DB           → Dexie.js IndexedDB wrapper
 *   - Calendar     → Monthly calendar rendering
 *   - Modal        → Trade entry form
 *   - TradeList    → Trade cards, tabs, filter, pagination
 *   - Stats        → Header stat calculations
 *   - GoogleDriveSync → OAuth2 + Drive upload logic
 *   - Network      → Online/Offline detection
 *   - Toast        → Notification utility
 * ═══════════════════════════════════════════════════════
 */

'use strict';

/* ─────────────────────────────────────────────
   ⓪ EARLY PWA INSTALL PROMPT CAPTURE
   beforeinstallprompt fires very early — sometimes
   before DOMContentLoaded — so we must capture it
   at the top-level, before any module code runs.
   ───────────────────────────────────────────── */
window.__pwaDeferred = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  window.__pwaDeferred = e;
  console.log('[PWA] beforeinstallprompt captured early ✓');
  // If PWA module is already initialised, notify it
  if (window.__pwaReadyCallback) window.__pwaReadyCallback(e);
});

/* ─────────────────────────────────────────────
   ① CONFIGURATION — replace with your own keys
   ───────────────────────────────────────────── */
const CONFIG = {
  CLIENT_ID: '772016867872-38rrvbtcdju4fnq922hngbotojcvb735.apps.googleusercontent.com',
  API_KEY:   'AIzaSyA8uy-PSeINyEprPFgqRVcoBSgciWiFw6M',
  SCOPES:    'https://www.googleapis.com/auth/drive.file',
  DRIVE_FOLDER_NAME: 'FX Journal Backups',
  PAGE_SIZE: 10,      // trades per page
};

/* ─────────────────────────────────────────────
   ② DATABASE — Dexie.js IndexedDB
   ───────────────────────────────────────────── */
const DB = (() => {
  // Initialise Dexie database
  const db = new Dexie('ForexJournalDB');

  db.version(1).stores({
    trades: '++id, date, type, pair, screenshotUrl, notes, outcome, rr, syncStatus'
  });

  // v2: adds checklist item definitions + per-trade checklist sessions
  db.version(2).stores({
    trades:           '++id, date, type, pair, screenshotUrl, notes, outcome, rr, syncStatus',
    checklistItems:   '++id, timeframe, order',
    checklistSessions:'++id, tradeId, date',
  });

  // v3: adds updatedAt + driveId indexes on trades for multi-device merge
  db.version(3).stores({
    // driveId MUST be indexed — bulkUpsertTrades queries .where('driveId')
    trades:           '++id, date, type, pair, screenshotUrl, notes, outcome, rr, syncStatus, updatedAt, driveId',
    checklistItems:   '++id, timeframe, order',
    checklistSessions:'++id, tradeId, date',
  }).upgrade(tx =>
    // Backfill updatedAt for existing rows so they are never null
    tx.table('trades').toCollection().modify(trade => {
      if (!trade.updatedAt) trade.updatedAt = trade.createdAt || new Date().toISOString();
    })
  );

  // v4: adds a deletedTrades tombstone table so deletions propagate across devices
  db.version(4).stores({
    trades:           '++id, date, type, pair, screenshotUrl, notes, outcome, rr, syncStatus, updatedAt, driveId',
    checklistItems:   '++id, timeframe, order',
    checklistSessions:'++id, tradeId, date',
    deletedTrades:    '++id, driveId, deletedAt',   // tombstone log
  });

  return {
    /**
     * Add a new trade record
     * @param {Object} trade - Trade data object
     * @returns {Promise<number>} New record id
     */
    addTrade: async (trade) => {
      const now        = new Date().toISOString();
      trade.syncStatus = 'pending';
      trade.createdAt  = now;
      trade.updatedAt  = now;   // ← timestamp for multi-device merge
      return await db.trades.add(trade);
    },

    /**
     * Update an existing trade by id
     * @param {number} id - Record id
     * @param {Object} changes - Fields to update
     */
    updateTrade: async (id, changes) => {
      changes.updatedAt = new Date().toISOString();   // ← bump timestamp on every edit
      return await db.trades.update(id, changes);
    },

    /**
     * Delete a trade by id, recording a tombstone so other devices remove it too.
     * @param {number} id - Record id
     */
    deleteTrade: async (id) => {
      const trade = await db.trades.get(id);
      if (trade?.driveId) {
        // Record a tombstone so the Drive backup will exclude this trade and
        // bulkUpsertTrades on other devices will know to delete it.
        await db.deletedTrades.add({
          driveId:   trade.driveId,
          deletedAt: new Date().toISOString(),
        }).catch(() => {}); // swallow duplicate-key errors
      }
      return await db.trades.delete(id);
    },

    /**
     * Fetch all trades (optionally filter by type)
     * @param {string|null} type - 'backtest', 'live', or null for all
     * @returns {Promise<Array>}
     */
    getTrades: async (type = null) => {
      if (type) return await db.trades.where('type').equals(type).reverse().sortBy('date');
      return await db.trades.orderBy('date').reverse().toArray();
    },

    /**
     * Fetch all pending (unsynced) trades
     * @returns {Promise<Array>}
     */
    getPendingTrades: async () => {
      return await db.trades.where('syncStatus').equals('pending').toArray();
    },

    /**
     * Fetch trades for a specific date
     * @param {string} dateStr - ISO date string YYYY-MM-DD
     * @returns {Promise<Array>}
     */
    getTradesByDate: async (dateStr) => {
      return await db.trades.where('date').equals(dateStr).toArray();
    },

    /**
     * Mark a list of trade ids as synced
     * @param {number[]} ids - Array of trade ids
     */
    markSynced: async (ids) => {
      return await db.trades.where('id').anyOf(ids).modify({ syncStatus: 'synced' });
    },

    /**
     * Return all tombstone records (driveIds of deleted trades)
     * @returns {Promise<Array<{driveId:string, deletedAt:string}>>}
     */
    getTombstones: async () => {
      return await db.deletedTrades.toArray();
    },

    /**
     * Remove tombstone entries whose driveId is no longer needed
     * (called after a successful Drive push to keep the table lean)
     * @param {string[]} driveIds
     */
    purgeTombstones: async (driveIds) => {
      return await db.deletedTrades.where('driveId').anyOf(driveIds).delete();
    },

    /**
     * Upsert an array of trades from a Drive backup.
     *
     * Drive is treated as the SINGLE SOURCE OF TRUTH on load:
     *  • Any trade present on Drive but missing locally → inserted.
     *  • Any trade where the Drive copy has a newer updatedAt → overwrites local.
     *  • Tombstoned driveIds (deleted on another device) → removed locally.
     *
     * @param {Object[]} remoteTrades - Array of trade objects from Drive JSON
     * @param {string[]} [tombstones=[]] - driveIds that were deleted on another device
     * @returns {Promise<{inserted:number, updated:number, skipped:number, removed:number}>}
     */
    bulkUpsertTrades: async (remoteTrades, tombstones = []) => {
      let inserted = 0, updated = 0, skipped = 0, removed = 0;

      // ── Step 1: apply deletions first (tombstones from Drive) ──
      for (const driveId of tombstones) {
        const local = await db.trades.where('driveId').equals(driveId).first();
        if (local) {
          await db.trades.delete(local.id);
          removed++;
        }
      }

      // ── Step 2: upsert surviving remote trades ──
      for (const remote of remoteTrades) {
        if (!remote.driveId) {
          remote.driveId = remote.id ? `legacy-${remote.id}` : `gen-${Date.now()}-${Math.random()}`;
        }

        // Skip trades that were locally deleted (tombstoned)
        const localTombstone = await db.deletedTrades.where('driveId').equals(remote.driveId).first();
        if (localTombstone) { skipped++; continue; }

        const existing = await db.trades.where('driveId').equals(remote.driveId).first();

        if (!existing) {
          const { id: _drop, ...rest } = remote;
          await db.trades.add({ ...rest, syncStatus: 'synced' });
          inserted++;
        } else {
          // Drive is source of truth: overwrite local unless local is strictly newer
          const remoteTime = new Date(remote.updatedAt || 0).getTime();
          const localTime  = new Date(existing.updatedAt || 0).getTime();
          if (remoteTime >= localTime) {
            await db.trades.update(existing.id, { ...remote, id: existing.id, syncStatus: 'synced' });
            updated++;
          } else {
            skipped++;
          }
        }
      }

      return { inserted, updated, skipped, removed };
    },

    /**
     * Return the most recent updatedAt value across all trades (ISO string or null)
     */
    getLatestUpdatedAt: async () => {
      const all = await db.trades.orderBy('updatedAt').reverse().first();
      return all?.updatedAt ?? null;
    },

    /** Raw Dexie db reference for advanced queries */
    raw: db,

    /* ── Checklist Item CRUD ── */
    getChecklistItems: async (timeframe = null) => {
      if (timeframe) return await db.checklistItems.where('timeframe').equals(timeframe).sortBy('order');
      return await db.checklistItems.orderBy('order').toArray();
    },
    addChecklistItem: async (item) => await db.checklistItems.add(item),
    updateChecklistItem: async (id, changes) => await db.checklistItems.update(id, changes),
    deleteChecklistItem: async (id) => await db.checklistItems.delete(id),

    /* ── Checklist Sessions ── */
    saveChecklistSession: async (session) => await db.checklistSessions.add(session),
    getChecklistSessionByTrade: async (tradeId) =>
      await db.checklistSessions.where('tradeId').equals(tradeId).last(),

    /* ── Seed default items if DB is fresh ── */
    seedChecklistDefaults: async () => {
      // Version key — bump this string whenever rules change to force a re-seed.
      const SEED_VERSION = 'amharic-v2';
      const storedVersion = localStorage.getItem('fx-checklist-seed-version');
      if (storedVersion === SEED_VERSION) return; // already seeded this version

      // Clear old rules and re-seed fresh
      await db.checklistItems.clear();
      localStorage.setItem('fx-checklist-seed-version', SEED_VERSION);
      const defaults = [
        // 4 checklist items — one per timeframe section
        {
          timeframe: 'HTF',
          label: 'HTF (Weekly/1W) — የታሪክ ግንባታ (Narrative Creation):\n1. የአሁኑን የዋጋ ጉዞ (Current Leg) ለይ፦ ዋጋው በከፍተኛ ግስጋሴ (Impulsive) ወይስ በትረማስ (Corrective) ላይ ነው?\n2. መዋቅራዊ አቅጣጫን ለይ፦ ገበያው HH/HL (Bullish) ወይስ LL/LH (Bearish) እየሠራ ነው? [22, 111]\n3. የሳምንቱን የዋጋ ክልል (Range) አውጣ፦ ዋጋው በዚህ ሳምንት ሊንቀሳቀስ የሚችልበትን ከፍተኛ እና ዝቅተኛ ነጥብ ምልክት አድርግ [112, 141]።\n4. ወደ ግራ ተመልከት (Look Left)፦ ያልተነኩ ቀጠናዎችን (Untapped POIs)፣ ሊኩዊዲቲ (EQH/EQL) እና ክፍተቶችን (Gaps/Inefficiency) ፈልግ [22, 113]።\n5. የሳምንቱን አቅጣጫ (Bias) ወስን፦ ዋጋው ወደ የትኛው ሊኩዊዲቲ ወይም ቀጠና እንደ ማግኔት ይሳባል? [23, 116]',
          order: 0,
        },
        {
          timeframe: 'MTF',
          label: 'MTF (1D, 4H) — ትንተናን ማጥራት (Narrative Refinement):\n1. የ HTF ታሪክን አረጋግጥ፦ በትልቁ ያየኸው አቅጣጫ አሁንም አልተቀየረም?\n2. ቀጠናዎችን አጥራ (Refine POIs)፦ የሳምንቱን ትላልቅ ቀጠናዎች ወደ ዕለታዊ ወይም የ 4 ሰዓት ጥቃቅን ቀጠናዎች ቀይር [28, 117]።\n3. የመንገዱን ግልጽነት አረጋግጥ፦ ዋጋው ከቀጠናው ተነስቶ እስከ ግቡ (Target) ድረስ የሚገታው ሌላ ቀጠና የለም?\n4. እቅድህን በዝርዝር አስቀምጥ፦ "ዋጋው ይህን POI ቢነካ እና LTF BOS ቢሰጠኝ፣ እገዛለሁ" — If This Then That [29, 104]።',
          order: 1,
        },
        {
          timeframe: 'LTF',
          label: 'LTF (1H እስከ 1m) — የንግድ አፈጻጸም (Narrative Trading):\n1. ቀጠና መነካቱን አረጋግጥ፦ ዋጋው የ MTF ቀጠና ውስጥ ገብቷል? [40, 211]\n2. Confirmation Entry (CE)፦ የመዋቅር ሽግግር (Structural Shift) ከተፈጠረ በኋላ ግባ [39, 237]።\n3. Momentum Entry (ME)፦ ገበያው በጣም ፈጣን ከሆነ ወዲያውኑ በሻማ አካል (Body Closure) ግባ [40, 253]።\n4. Body Closure፦ BOS በሻማ አካል እንጂ በጅራት (Wick) ብቻ አለመሆኑን አረጋግጥ [188, 210]።\n5. ስጋት 1% ብቻ — RR ቢያንስ 1:3 መሆኑን አረጋግጥ [48, 522, 523, 524]።\n6. SL አቀማመጥ፦ ቀጠናው ከከሸፈ (Invalidation point) ትሬዱ ትርጉም በማይሰጥበት ቦታ ላይ አድርግ [264, 270]።',
          order: 2,
        },
        {
          timeframe: 'LTF+',
          label: '"Trades Inside of Trades" አወሳሰድ (LTF Framework):\n1. የትልቁን አቅጣጫ እወቅ፦ HTF ለሽያጭ (Sell) ከጠበቀ ዋጋው ወደ ሽያጭ ቀጠናው የሚመለስበትን Pullback ለይ።\n2. የጥቃቅን BOS ፈልግ፦ ዋጋው Pullback ሲያደርግ በ 15m ወይም 5m ለግዢ (Buy) BOS ካሳየ እንደ ገለልተኛ ትሬድ ውሰደው [34, 137]።\n3. ግልጽ TP ይኑርህ፦ TP በትልቁ ታሪክ ካለው የሽያጭ ቀጠና (Supply) በላይ መሄድ የለበትም [129, 135]።\n4. ሁለት ጊዜ አትቀጣ፦ ውስጣዊ ትሬዱ ላይ የምትወስደው ስጋት ከጠቅላላው 1% እንዳይበልጥ ተጠንቀቅ።',
          order: 3,
        },
      ];
      await db.checklistItems.bulkAdd(defaults);
    },
  };
})();

/* ─────────────────────────────────────────────
   ③ TOAST — notification utility
   ───────────────────────────────────────────── */
const Toast = (() => {
  let _timer = null;

  const ICONS = {
    success: 'fas fa-circle-check',
    error:   'fas fa-circle-xmark',
    info:    'fas fa-circle-info',
    warn:    'fas fa-triangle-exclamation',
  };

  /**
   * Show a toast notification
   * @param {string} message - Toast text
   * @param {'success'|'error'|'info'|'warn'} type
   * @param {number} duration - ms to show (default 3500)
   */
  const show = (message, type = 'info', duration = 3500) => {
    const el      = document.getElementById('toast');
    const inner   = document.getElementById('toastInner');
    const msgEl   = document.getElementById('toastMsg');
    const iconEl  = document.getElementById('toastIcon');

    // Reset classes
    inner.className = `flex items-center gap-3 px-4 py-3 rounded-xl border text-sm font-medium shadow-card backdrop-blur-sm transition-all duration-300 toast-${type}`;
    iconEl.className = ICONS[type] + ' text-base';
    msgEl.textContent = message;

    el.classList.remove('hidden');

    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(() => el.classList.add('hidden'), duration);
  };

  return { show };
})();

/* ─────────────────────────────────────────────
   ④ CALENDAR MODULE
   ───────────────────────────────────────────── */
const Calendar = (() => {
  // Internal state
  let _currentDate = new Date();
  let _tradesByDate = {};  // cache: { 'YYYY-MM-DD': [trade, …] }

  /** Format Date to YYYY-MM-DD */
  const _toISODate = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  /** Pad number with leading zero */
  const _pad = (n) => String(n).padStart(2, '0');

  /** Load all trades for current month into the cache */
  const _loadMonthTrades = async () => {
    const year  = _currentDate.getFullYear();
    const month = _currentDate.getMonth();

    // Start and end of month (inclusive)
    const startStr = `${year}-${_pad(month + 1)}-01`;
    const lastDay  = new Date(year, month + 1, 0).getDate();
    const endStr   = `${year}-${_pad(month + 1)}-${_pad(lastDay)}`;

    const all = await DB.raw.trades
      .where('date')
      .between(startStr, endStr, true, true)
      .toArray();

    // Group by date
    _tradesByDate = {};
    all.forEach(t => {
      if (!_tradesByDate[t.date]) _tradesByDate[t.date] = [];
      _tradesByDate[t.date].push(t);
    });
  };

  /** Render the calendar grid for _currentDate's month */
  const render = async () => {
    await _loadMonthTrades();

    const year  = _currentDate.getFullYear();
    const month = _currentDate.getMonth();

    // Update header label
    const label = document.getElementById('calendarMonthLabel');
    label.textContent = new Date(year, month, 1).toLocaleDateString('en-US', {
      month: 'long', year: 'numeric'
    });

    const grid    = document.getElementById('calendarGrid');
    const today   = new Date();
    const todayStr = _toISODate(today);

    // First day of month & total days
    const firstDay   = new Date(year, month, 1).getDay();  // 0 = Sun
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    // Days from previous month to fill first row
    const prevMonthDays = new Date(year, month, 0).getDate();

    let html = '';

    // ── Previous month padding ──
    for (let i = firstDay - 1; i >= 0; i--) {
      const day = prevMonthDays - i;
      html += `<div class="calendar-day other-month">
        <span class="day-number">${day}</span>
      </div>`;
    }

    // ── Current month days ──
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr  = `${year}-${_pad(month + 1)}-${_pad(d)}`;
      const isToday  = dateStr === todayStr;
      const trades   = _tradesByDate[dateStr] || [];

      // Build trade dots (max 6 dots displayed)
      const dots = trades.slice(0, 6).map(t =>
        `<span class="trade-dot ${t.outcome}" title="${t.pair} — ${t.outcome}"></span>`
      ).join('');

      // Mini win/loss count
      const wins   = trades.filter(t => t.outcome === 'win').length;
      const losses = trades.filter(t => t.outcome === 'loss').length;
      const miniStat = trades.length
        ? `<span class="day-mini-stat text-win">${wins}W</span>
           ${losses ? `<span class="day-mini-stat text-loss ml-0.5">${losses}L</span>` : ''}`
        : '';

      html += `
        <div class="calendar-day${isToday ? ' today' : ''}"
             onclick="Calendar.dayClick('${dateStr}', event)"
             title="${dateStr}${trades.length ? ` — ${trades.length} trade(s)` : ''}">
          <div class="flex items-center justify-between">
            <span class="day-number">${d}</span>
            <div class="flex items-center gap-0.5">${miniStat}</div>
          </div>
          ${trades.length ? `<div class="day-trades">${dots}</div>` : ''}
        </div>`;
    }

    // ── Next month padding to complete last row ──
    const totalCells = firstDay + daysInMonth;
    const remaining  = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
    for (let d = 1; d <= remaining; d++) {
      html += `<div class="calendar-day other-month">
        <span class="day-number">${d}</span>
      </div>`;
    }

    grid.innerHTML = html;
  };

  /** Navigate to previous month */
  const prevMonth = async () => {
    _currentDate = new Date(_currentDate.getFullYear(), _currentDate.getMonth() - 1, 1);
    await render();
  };

  /** Navigate to next month */
  const nextMonth = async () => {
    _currentDate = new Date(_currentDate.getFullYear(), _currentDate.getMonth() + 1, 1);
    await render();
  };

  /** Handle day cell click — open trade modal for that date */
  const dayClick = (dateStr, event) => {
    // Prevent clicks on other-month cells propagating oddly
    if (event.currentTarget.classList.contains('other-month')) return;
    Modal.open(dateStr);
  };

  /** Re-render calendar (called after trade save/delete) */
  const refresh = async () => await render();

  return { render, prevMonth, nextMonth, dayClick, refresh };
})();

/* ─────────────────────────────────────────────
   ⑤ MODAL MODULE — Trade entry form
   ───────────────────────────────────────────── */
const Modal = (() => {
  let _editId = null;

  /** Open modal for a given date (or pre-populate for edit) */
  const open = (dateStr, existingTrade = null) => {
    const modal = document.getElementById('tradeModal');
    _editId = existingTrade ? existingTrade.id : null;

    // Set date display
    const dateDisplay = new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
    document.getElementById('modalDate').textContent = dateDisplay;
    document.getElementById('modalTitle').textContent = existingTrade ? 'Edit Trade' : 'Log Trade';
    document.getElementById('formDate').value = dateStr;
    document.getElementById('formTradeId').value = existingTrade ? existingTrade.id : '';

    // Populate fields (edit mode or defaults)
    const t = existingTrade;
    setTradeType(t?.type || 'backtest');
    setOutcome(t?.outcome || 'win');
    document.getElementById('formPair').value       = t?.pair || '';
    document.getElementById('formRR').value         = t?.rr || '';
    document.getElementById('formScreenshot').value = t?.screenshotUrl || '';
    document.getElementById('formNotes').value      = t?.notes || '';

    modal.classList.remove('hidden');
    document.getElementById('formPair').focus();
  };

  /** Close modal and reset form */
  const close = () => {
    document.getElementById('tradeModal').classList.add('hidden');
    document.getElementById('tradeForm').reset();
    _editId = null;
  };

  /** Handle backdrop click — close only if clicking outside modal-box */
  const handleBackdropClick = (e) => {
    if (e.target === document.getElementById('tradeModal')) close();
  };

  /** Toggle Trade Type button state */
  const setTradeType = (type) => {
    document.getElementById('formType').value = type;
    document.getElementById('typeBacktest').classList.toggle('active-type', type === 'backtest');
    document.getElementById('typeLive').classList.toggle('active-type', type === 'live');
  };

  /** Toggle Outcome button state */
  const setOutcome = (outcome) => {
    document.getElementById('formOutcome').value = outcome;
    document.getElementById('outcomeWin').classList.toggle('active-outcome', outcome === 'win');
    document.getElementById('outcomeLoss').classList.toggle('active-outcome', outcome === 'loss');
  };

  /** Handle form submission — save to IndexedDB */
  const submitForm = async (e) => {
    e.preventDefault();

    const pair = document.getElementById('formPair').value.trim();
    if (!pair) {
      Toast.show('Please enter a currency pair.', 'warn');
      document.getElementById('formPair').focus();
      return;
    }

    const tradeData = {
      date:          document.getElementById('formDate').value,
      type:          document.getElementById('formType').value,
      pair:          pair.toUpperCase(),
      outcome:       document.getElementById('formOutcome').value,
      rr:            parseFloat(document.getElementById('formRR').value) || null,
      screenshotUrl: document.getElementById('formScreenshot').value.trim(),
      notes:         document.getElementById('formNotes').value.trim(),
    };

    try {
      if (_editId) {
        // Update existing trade (keep syncStatus as pending for re-sync)
        await DB.updateTrade(_editId, { ...tradeData, syncStatus: 'pending' });
        Toast.show('Trade updated successfully.', 'success');
      } else {
        // New trade
        await DB.addTrade(tradeData);
        Toast.show(`Trade logged: ${tradeData.pair} — ${tradeData.outcome.toUpperCase()}`, 'success');
      }

      close();

      // Refresh UI
      await Promise.all([
        Calendar.refresh(),
        TradeList.load(),
        Stats.update(),
      ]);

      // ── Real-time auto-sync ──
      // Fire a debounced background push to Drive.
      // If offline, autoSync() is a no-op — the change is already
      // stored locally as 'pending' and will be pushed when back online.
      GoogleDriveSync.autoSync();

    } catch (err) {
      console.error('[Modal] Save error:', err);
      Toast.show('Failed to save trade. Try again.', 'error');
    }
  };

  return { open, close, handleBackdropClick, setTradeType, setOutcome, submitForm };
})();

/* ─────────────────────────────────────────────
   ⑥ TRADE LIST MODULE — Cards, tabs, filter, pagination
   ───────────────────────────────────────────── */
const TradeList = (() => {
  let _activeTab  = 'backtest';   // 'backtest' | 'live'
  let _allTrades  = [];           // current tab's full trade list
  let _filtered   = [];           // after filter applied
  let _page       = 1;

  /** Switch active tab */
  const switchTab = async (tab) => {
    _activeTab = tab;
    _page = 1;

    document.getElementById('tabBacktest').classList.toggle('active-tab', tab === 'backtest');
    document.getElementById('tabLive').classList.toggle('active-tab', tab === 'live');

    await load();
  };

  /** Load trades for current tab from DB */
  const load = async () => {
    _allTrades = await DB.getTrades(_activeTab);

    // Update tab counts
    const backtestAll = await DB.getTrades('backtest');
    const liveAll     = await DB.getTrades('live');
    document.getElementById('cntBacktest').textContent = backtestAll.length;
    document.getElementById('cntLive').textContent     = liveAll.length;

    applyFilters();
  };

  /** Apply search/date filters and re-render */
  const applyFilters = () => {
    const pairFilter  = document.getElementById('filterPair').value.trim().toUpperCase();
    const dateFrom    = document.getElementById('filterDateFrom')?.value || '';
    const dateTo      = document.getElementById('filterDateTo')?.value || '';

    _filtered = _allTrades.filter(t => {
      const pairMatch = !pairFilter || t.pair.includes(pairFilter);
      const fromMatch = !dateFrom || t.date >= dateFrom;
      const toMatch   = !dateTo   || t.date <= dateTo;
      return pairMatch && fromMatch && toMatch;
    });

    _page = 1;
    render();
  };

  /** Clear all filters */
  const clearFilters = async () => {
    document.getElementById('filterPair').value = '';
    const fromEl = document.getElementById('filterDateFrom');
    const toEl   = document.getElementById('filterDateTo');
    if (fromEl) fromEl.value = '';
    if (toEl)   toEl.value   = '';
    await applyFilters();
  };

  /** Render current page of trade cards */
  const render = () => {
    const container  = document.getElementById('tradeCards');
    const emptyState = document.getElementById('emptyState');
    const pagination = document.getElementById('pagination');

    if (_filtered.length === 0) {
      container.innerHTML = '';
      emptyState.classList.add('show');
      pagination.classList.add('hidden');
      return;
    }

    emptyState.classList.remove('show');

    // Pagination
    const totalPages = Math.ceil(_filtered.length / CONFIG.PAGE_SIZE);
    const start = (_page - 1) * CONFIG.PAGE_SIZE;
    const end   = Math.min(start + CONFIG.PAGE_SIZE, _filtered.length);
    const pageData = _filtered.slice(start, end);

    // Render cards
    container.innerHTML = pageData.map(t => _buildCard(t)).join('');

    // Update pagination controls
    if (totalPages > 1) {
      pagination.classList.remove('hidden');
      document.getElementById('pageInfo').textContent =
        `Page ${_page} of ${totalPages} — ${_filtered.length} trade${_filtered.length !== 1 ? 's' : ''}`;
      document.getElementById('btnPrev').disabled = _page <= 1;
      document.getElementById('btnNext').disabled = _page >= totalPages;
    } else {
      pagination.classList.add('hidden');
    }
  };

  /** Build HTML for a single trade card */
  const _buildCard = (t) => {
    const outcomeClass = t.outcome === 'win' ? 'win' : 'loss';
    const outcomeIcon  = t.outcome === 'win' ? 'fa-check-circle' : 'fa-xmark-circle';
    const outcomeLabel = t.outcome === 'win' ? 'Win' : 'Loss';

    const dateDisplay = new Date(t.date + 'T00:00:00').toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    });

    const rrDisplay = t.rr != null ? `1:${t.rr}` : '—';

    const screenshotLink = t.screenshotUrl
      ? `<a href="${_escHtml(t.screenshotUrl)}" target="_blank" rel="noopener" class="card-btn">
           <i class="fas fa-image"></i>Chart
         </a>`
      : `<span class="card-btn opacity-40 cursor-not-allowed"><i class="fas fa-image"></i>No Chart</span>`;

    const syncDot = t.syncStatus === 'synced'
      ? `<span class="sync-dot synced" title="Synced to Drive"></span>`
      : `<span class="sync-dot pending" title="Pending sync"></span>`;

    const notesHtml = t.notes
      ? `<p class="trade-notes">${_escHtml(t.notes)}</p>`
      : '';

    return `
      <div class="trade-card ${outcomeClass}" data-id="${t.id}">
        <div class="trade-card-header">
          <span class="trade-pair">${_escHtml(t.pair)}</span>
          <span class="outcome-badge ${outcomeClass}">
            <i class="fas ${outcomeIcon} text-[10px]"></i>${outcomeLabel}
          </span>
        </div>

        <div class="trade-meta">
          <span class="meta-chip">
            <i class="fas fa-calendar-day"></i>
            <strong>${dateDisplay}</strong>
          </span>
          <span class="meta-chip">
            <i class="fas fa-scale-balanced"></i>
            <strong>RR ${rrDisplay}</strong>
          </span>
          <span class="meta-chip" title="${t.syncStatus === 'synced' ? 'Synced to Drive' : 'Pending sync'}">
            ${syncDot}
          </span>
        </div>

        ${notesHtml}

        <div class="trade-card-actions">
          ${screenshotLink}
          <button class="card-btn" onclick="TradeList.editTrade(${t.id})">
            <i class="fas fa-pen-to-square"></i>Edit
          </button>
          <button class="card-btn delete" onclick="TradeList.deleteTrade(${t.id})">
            <i class="fas fa-trash-can"></i>Delete
          </button>
        </div>
      </div>`;
  };

  /** Escape HTML to prevent XSS */
  const _escHtml = (str) => {
    if (!str) return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
              .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
  };

  /** Open edit modal for a trade */
  const editTrade = async (id) => {
    const trade = await DB.raw.trades.get(id);
    if (trade) Modal.open(trade.date, trade);
  };

  /** Delete a trade with confirmation */
  const deleteTrade = async (id) => {
    if (!confirm('Delete this trade? This cannot be undone.')) return;
    try {
      await DB.deleteTrade(id);
      Toast.show('Trade deleted.', 'info');
      await Promise.all([Calendar.refresh(), load(), Stats.update()]);

      // ── Real-time auto-sync ──
      // Debounced background push; tombstone is already recorded in IndexedDB.
      // If offline, autoSync() is a no-op — push happens on reconnect.
      GoogleDriveSync.autoSync();
    } catch (err) {
      console.error('[TradeList] Delete error:', err);
      Toast.show('Failed to delete trade.', 'error');
    }
  };

  const prevPage = () => { if (_page > 1) { _page--; render(); } };
  const nextPage = () => {
    const totalPages = Math.ceil(_filtered.length / CONFIG.PAGE_SIZE);
    if (_page < totalPages) { _page++; render(); }
  };

  return { switchTab, load, applyFilters, clearFilters, editTrade, deleteTrade, prevPage, nextPage };
})();

/* ─────────────────────────────────────────────
   ⑦ STATS MODULE — Tabbed Backtest / Live
   RR P&L logic:
     winRR  = sum of RR values on winning trades
     lossRR = sum of RR values on losing trades
     netRR  = winRR − lossRR
   e.g. win 5R + win 3R − loss 1R − loss 2R = +5R net
   ───────────────────────────────────────────── */
const Stats = (() => {
  // Which tab is currently showing in the stats panel
  let _activeTab = 'backtest';

  // Cache both datasets so switching tabs doesn't re-query DB
  let _cache = { backtest: null, live: null };

  /* ── Helpers ── */
  const _set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  const _setClass = (id, cls) => {
    const el = document.getElementById(id);
    if (el) { el.className = el.className.replace(/text-(win|loss|yellow-400|brand|white)/g, ''); el.classList.add(cls); }
  };
  const _barWidth = (id, pct) => {
    const el = document.getElementById(id);
    if (el) el.style.width = `${Math.min(Math.max(pct, 0), 100)}%`;
  };

  /**
   * Calculate all stats for an array of trades.
   * RR P&L: winRR = Σ(RR of wins), lossRR = Σ(RR of losses), net = winRR − lossRR
   * Win rate = wins / total × 100
   */
  const _calc = (trades) => {
    const total  = trades.length;
    const wins   = trades.filter(t => t.outcome === 'win').length;
    const losses = trades.filter(t => t.outcome === 'loss').length;

    // Win rate as percentage
    const wr = total > 0 ? Math.round((wins / total) * 100) : null;

    // Sum RR for winning trades (treat missing RR as 1 — 1 unit risk)
    const winRR = trades
      .filter(t => t.outcome === 'win')
      .reduce((sum, t) => sum + (parseFloat(t.rr) || 1), 0);

    // Sum RR for losing trades
    const lossRR = trades
      .filter(t => t.outcome === 'loss')
      .reduce((sum, t) => sum + (parseFloat(t.rr) || 1), 0);

    // Net RR = winRR − lossRR (can be negative)
    const netRR = winRR - lossRR;

    return { total, wins, losses, wr, winRR, lossRR, netRR };
  };

  /** Render stats panel for the given calculated data object */
  const _render = (data) => {
    const { total, wins, losses, wr, winRR, lossRR, netRR } = data;

    // ── Counts ──
    _set('statTotal',  total);
    _set('statWins',   wins);
    _set('statLosses', losses);
    _set('statWR',     wr !== null ? `${wr}%` : '—');

    // ── RR P&L ──
    _set('statWinRR',  winRR.toFixed(2)  + 'R');
    _set('statLossRR', lossRR.toFixed(2) + 'R');

    // Net RR — colour-coded green/red
    const netEl = document.getElementById('statNetRR');
    if (netEl) {
      const formatted = (netRR >= 0 ? '+' : '') + netRR.toFixed(2) + 'R';
      netEl.textContent = total > 0 ? formatted : '—';
      netEl.className   = netEl.className.replace(/text-\S+/g, '');
      netEl.classList.add(
        total === 0 ? 'text-slate-400'
        : netRR > 0  ? 'text-win'
        : netRR < 0  ? 'text-loss'
        : 'text-slate-300'
      );
    }

    // ── RR bar (win proportion vs loss proportion) ──
    const totalRR = winRR + lossRR;
    if (totalRR > 0) {
      _barWidth('rrWinBar',  (winRR  / totalRR) * 100);
      _barWidth('rrLossBar', (lossRR / totalRR) * 100);
    } else {
      _barWidth('rrWinBar',  0);
      _barWidth('rrLossBar', 0);
    }
  };

  /** Switch tab and re-render cached data */
  const switchTab = (tab) => {
    _activeTab = tab;

    // Update tab button styles
    document.getElementById('statsTabBacktest').classList.toggle('active-stats-tab', tab === 'backtest');
    document.getElementById('statsTabLive').classList.toggle('active-stats-tab', tab === 'live');

    // Render cached data for selected tab
    if (_cache[tab]) _render(_calc(_cache[tab]));
  };

  /** Fetch fresh data from DB and re-render current tab */
  const update = async () => {
    _cache.backtest = await DB.getTrades('backtest');
    _cache.live     = await DB.getTrades('live');
    _render(_calc(_cache[_activeTab]));
  };

  return { update, switchTab };
})();

/* ─────────────────────────────────────────────
   ⑧ GOOGLE DRIVE SYNC MODULE  (v3 — auto-sync, tombstones, offline queue)
   ─────────────────────────────────────────────
   Design
   ──────
   • Single canonical file  "fx-journal-master.json"  in the Drive folder.
     Every push PATCHes that one file — no accumulation of snapshots.

   • driveId  — a UUID stamped on every trade at first push; the stable key
     used for merge/upsert across devices.  Local auto-increment ids must NOT
     be used for deduplication.

   • updatedAt — ISO timestamp bumped on every add/edit.  Merge keeps the
     copy (local vs remote) with the newer timestamp.  Drive wins on ties.

   • Tombstones — deletions are tracked in IndexedDB deletedTrades table and
     propagated in the Drive JSON so other devices remove the same trade.

   • Auto-sync on load
       1. _trySilentAuth()    — silent OAuth2 token on app start
       2. _fetchAndMerge()    — pull Drive JSON → hard merge into IndexedDB
                                (Drive is source of truth at startup)
       3. _pushSnapshot()     — upload full state back to Drive

   • Real-time push on change
       Modal.submitForm / TradeList.deleteTrade call autoSync() after every
       local write.  If offline the change stays 'pending' and autoSync()
       no-ops; the online handler calls it again when connectivity returns.

   • Offline queue
       navigator.onLine is checked before every push.  Coming back online
       triggers fetchExistingBackup → syncPendingTrades via Network.init().
   ───────────────────────────────────────────── */
const GoogleDriveSync = (() => {
  let _accessToken = null;
  let _tokenClient = null;
  let _folderId    = null;

  // Drive file ID of fx-journal-master.json — persisted in localStorage
  const LS_MASTER_ID = 'fxj_master_file_id';
  let _masterId = localStorage.getItem(LS_MASTER_ID) || null;

  const MASTER_FILE = 'fx-journal-master.json';

  // Debounce timer for _autoSync to avoid rapid successive uploads
  let _syncDebounceTimer = null;
  const SYNC_DEBOUNCE_MS = 1200;

  // Prevent concurrent uploads
  let _syncInProgress = false;

  /* ── Public: is the user authenticated? ── */
  const isConnected = () => !!_accessToken;

  /* ────────────────────────────────────────────
     GSI initialisation
     ──────────────────────────────────────────── */
  const _initGSI = () => {
    if (typeof google === 'undefined' || !google?.accounts?.oauth2) return;

    _tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.CLIENT_ID,
      scope:     CONFIG.SCOPES,
      callback:  async (response) => {
        if (response.error) {
          console.error('[GSI] Token error:', response.error);
          Toast.show('Google auth failed: ' + response.error, 'error');
          return;
        }

        _accessToken = response.access_token;
        _updateDriveButton(true);
        Toast.show('Connected to Google Drive ✓', 'success');

        // On every (re-)connect: merge Drive → local, then push
        await _fetchAndMerge({ silent: false });
        await _pushSnapshot({ quiet: false });
      },
    });
  };

  /* ────────────────────────────────────────────
     Silent token refresh — called on app init.

     GSI implicit grant with prompt:'' silently
     issues a token when the user has an active
     Google session and previously granted consent.
     A 6 s timeout prevents hanging if the callback
     never fires (some browsers / network states).
     ──────────────────────────────────────────── */
  const _trySilentAuth = () => {
    return new Promise((resolve) => {
      if (typeof google === 'undefined' || !google?.accounts?.oauth2) {
        resolve(false);
        return;
      }

      // Safety net: if the callback never fires, give up after 6 s
      const timeout = setTimeout(() => {
        console.info('[GSI] Silent auth timed out.');
        resolve(false);
      }, 6000);

      try {
        const silentClient = google.accounts.oauth2.initTokenClient({
          client_id: CONFIG.CLIENT_ID,
          scope:     CONFIG.SCOPES,
          // prompt:'' = no UI; errors resolve(false) gracefully
          callback:  async (response) => {
            clearTimeout(timeout);

            if (response.error || !response.access_token) {
              console.info('[GSI] Silent auth not available:', response.error || 'no token');
              resolve(false);
              return;
            }

            _accessToken = response.access_token;
            _updateDriveButton(true);
            console.info('[GSI] Silent auth OK — pulling Drive snapshot…');

            // ── AUTO-SYNC ON LOAD ──
            // 1. Fetch Drive JSON; hard-merge (Drive = source of truth)
            await _fetchAndMerge({ silent: true });
            // 2. Push merged state back (stamps driveIds, marks synced)
            await _pushSnapshot({ quiet: true });

            resolve(true);
          },
        });

        silentClient.requestAccessToken({ prompt: '' });

      } catch (err) {
        clearTimeout(timeout);
        console.info('[GSI] Silent auth error:', err.message);
        resolve(false);
      }
    });
  };

  /* ────────────────────────────────────────────
     Public: trigger OAuth2 popup
     ──────────────────────────────────────────── */
  const connectGoogleDrive = () => {
    if (CONFIG.CLIENT_ID === 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com') {
      Toast.show('Configure CLIENT_ID in CONFIG at top of app.js first.', 'warn', 5000);
      return;
    }

    if (!_tokenClient) {
      _initGSI();
      if (!_tokenClient) {
        Toast.show('Google Identity Services not loaded yet. Try again.', 'warn');
        return;
      }
    }

    _tokenClient.requestAccessToken({ prompt: 'consent' });
  };

  /* ────────────────────────────────────────────
     Drive button UI
     ──────────────────────────────────────────── */
  const _updateDriveButton = (connected) => {
    const label = document.getElementById('driveLabel');
    const btn   = document.getElementById('btnGoogleDrive');
    if (connected) {
      label.textContent = 'Drive Connected';
      btn.classList.add('border-brand/40', 'text-brand');
    } else {
      label.textContent = 'Connect Drive';
      btn.classList.remove('border-brand/40', 'text-brand');
    }
  };

  /* ────────────────────────────────────────────
     Get or create the app folder on Google Drive
     ──────────────────────────────────────────── */
  const _getOrCreateFolder = async () => {
    if (_folderId) return _folderId;

    const q = encodeURIComponent(
      `name='${CONFIG.DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
    );
    const res  = await _driveGet(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`);
    const data = await res.json();

    if (data.files?.length > 0) {
      _folderId = data.files[0].id;
      return _folderId;
    }

    // Create folder
    const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
      method:  'POST',
      headers: { Authorization: `Bearer ${_accessToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: CONFIG.DRIVE_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    });
    const created = await createRes.json();
    _folderId = created.id;
    return _folderId;
  };

  /* ────────────────────────────────────────────
     Convenience: authenticated GET to Drive API
     ──────────────────────────────────────────── */
  const _driveGet = (url) =>
    fetch(url, { headers: { Authorization: `Bearer ${_accessToken}` } });

  /* ────────────────────────────────────────────
     Upload / update the master JSON file on Drive.

     • First upload  → POST multipart (creates the file)
     • Subsequent    → PATCH multipart (updates in-place, same file ID)
     This keeps Drive clean — one file, always current.
     ──────────────────────────────────────────── */
  const _upsertMasterFile = async (payload, folderId) => {
    const boundary    = '-------FXJournalBoundary314159';
    const delimiter   = `\r\n--${boundary}\r\n`;
    const closeDelim  = `\r\n--${boundary}--`;
    const encoder     = new TextEncoder();
    const jsonStr     = JSON.stringify(payload, null, 2);

    const buildBody = (metadata) => {
      const metaPart  = delimiter + 'Content-Type: application/json\r\n\r\n' + JSON.stringify(metadata);
      const mediaPart = delimiter + 'Content-Type: application/json\r\n\r\n';
      const metaB     = encoder.encode(metaPart);
      const mediaB    = encoder.encode(mediaPart);
      const jsonB     = encoder.encode(jsonStr);
      const closeB    = encoder.encode(closeDelim);
      const buf       = new Uint8Array(metaB.length + mediaB.length + jsonB.length + closeB.length);
      let off = 0;
      [metaB, mediaB, jsonB, closeB].forEach(a => { buf.set(a, off); off += a.length; });
      return buf;
    };

    const headers = {
      Authorization:  `Bearer ${_accessToken}`,
      'Content-Type': `multipart/related; boundary="${boundary}"`,
    };

    let res;
    if (_masterId) {
      // PATCH — update existing file (no parents field on update)
      res = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${_masterId}?uploadType=multipart&fields=id,name,modifiedTime`,
        { method: 'PATCH', headers, body: buildBody({ name: MASTER_FILE, mimeType: 'application/json' }) }
      );
    } else {
      // POST — first upload
      res = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime`,
        { method: 'POST', headers, body: buildBody({ name: MASTER_FILE, parents: [folderId], mimeType: 'application/json' }) }
      );
    }

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || `Drive upload failed (${res.status})`);
    }

    const meta = await res.json();
    _masterId = meta.id;
    localStorage.setItem(LS_MASTER_ID, _masterId);  // persist so PATCH survives page reload
    return meta;
  };

  /* ────────────────────────────────────────────
     _fetchAndMerge — PULL from Drive and hard-merge
     into local IndexedDB.

     Drive is the authoritative source of truth on
     startup.  Any trade in the Drive backup that is
     missing locally (or has a newer/equal updatedAt)
     is written to IndexedDB.  Tombstones in the
     backup cause matching local trades to be deleted.

     @param {{ silent?: boolean }} opts
     ──────────────────────────────────────────── */
  const _fetchAndMerge = async ({ silent = false } = {}) => {
    if (!_accessToken) return null;

    try {
      const folderId = await _getOrCreateFolder();

      // Resolve the master file ID (cached or searched)
      let masterFileId = _masterId;

      if (!masterFileId) {
        const q   = encodeURIComponent(
          `name='${MASTER_FILE}' and '${folderId}' in parents and trashed=false`
        );
        const res  = await _driveGet(
          `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime%20desc&pageSize=1`
        );
        const data = await res.json();

        if (data.error) throw new Error(data.error.message || 'Drive API error during search');
        if (!data.files?.length) {
          if (!silent) Toast.show('No existing backup found on Drive.', 'info');
          return null;
        }
        masterFileId = data.files[0].id;
        _masterId    = masterFileId;
        localStorage.setItem(LS_MASTER_ID, _masterId);
        console.info(`[DriveSync] Found master file: ${masterFileId}`);
      } else {
        // Verify the cached file still exists
        const checkRes  = await _driveGet(
          `https://www.googleapis.com/drive/v3/files/${masterFileId}?fields=id,trashed`
        );
        const checkData = await checkRes.json();
        if (checkData.error || checkData.trashed) {
          console.warn('[DriveSync] Cached master file gone — clearing cache.');
          _masterId = null;
          localStorage.removeItem(LS_MASTER_ID);
          if (!silent) Toast.show('No existing backup found on Drive.', 'info');
          return null;
        }
      }

      // Download the JSON payload
      const dlRes = await _driveGet(
        `https://www.googleapis.com/drive/v3/files/${masterFileId}?alt=media`
      );
      if (!dlRes.ok) throw new Error(`Download failed (${dlRes.status})`);

      const backup = await dlRes.json();

      const remoteTrades = Array.isArray(backup.trades)    ? backup.trades    : [];
      const tombstones   = Array.isArray(backup.tombstones) ? backup.tombstones : [];

      if (remoteTrades.length === 0 && tombstones.length === 0) {
        if (!silent) Toast.show('Drive backup is empty — nothing to restore.', 'info');
        return backup;
      }

      // Hard-merge: Drive is source of truth
      const { inserted, updated, skipped, removed } =
        await DB.bulkUpsertTrades(remoteTrades, tombstones);

      console.info(
        `[DriveSync] Merge — inserted:${inserted} updated:${updated} skipped:${skipped} removed:${removed}`
      );

      if (inserted + updated + removed > 0) {
        const msg = [
          inserted ? `+${inserted} new`   : '',
          updated  ? `${updated} updated` : '',
          removed  ? `${removed} deleted` : '',
        ].filter(Boolean).join(', ');

        Toast.show(`Drive sync: ${msg}`, 'info', 4000);
        await Promise.all([Calendar.refresh(), TradeList.load(), Stats.update()]);
      }

      return backup;

    } catch (err) {
      console.error('[DriveSync] Fetch-merge error:', err);
      if (!silent) Toast.show(`Restore failed: ${err.message}`, 'error');
      return null;
    }
  };

  /* ────────────────────────────────────────────
     _pushSnapshot — PUSH all local trades to Drive.

     • Stamps a stable driveId on any trade missing one.
     • Includes the local tombstone list so other
       devices apply the same deletions.
     • Marks all pending trades as 'synced'.
     • Guards against concurrent calls and offline state.

     @param {{ quiet?: boolean, showOverlay?: boolean }} opts
     ──────────────────────────────────────────── */
  const _pushSnapshot = async ({ quiet = false, showOverlay = false } = {}) => {
    if (!_accessToken) {
      if (!quiet) Toast.show('Connect Google Drive first.', 'warn');
      return;
    }
    if (!navigator.onLine) {
      console.info('[DriveSync] Offline — push deferred.');
      return;
    }
    if (_syncInProgress) {
      console.info('[DriveSync] Sync already in progress — skipping.');
      return;
    }

    _syncInProgress = true;
    const syncIcon = document.getElementById('syncIcon');
    syncIcon?.classList.add('spin');
    if (showOverlay) _showSyncOverlay('Syncing to Drive…');

    try {
      // Stamp driveId on any new trades
      const allTrades = await DB.getTrades();
      const tombstones = await DB.getTombstones();

      if (allTrades.length === 0 && tombstones.length === 0) {
        if (!quiet) Toast.show('No trades to sync yet.', 'info');
        return;
      }

      const needsDriveId = allTrades.filter(t => !t.driveId);
      for (const t of needsDriveId) {
        const driveId = `trade-${t.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await DB.updateTrade(t.id, { driveId });
        t.driveId = driveId;
      }

      const trades    = await DB.getTrades();
      const pending   = trades.filter(t => t.syncStatus === 'pending');
      const folderId  = await _getOrCreateFolder();
      const now       = new Date().toISOString();

      const payload = {
        appVersion:  '3.0',
        lastSynced:  now,
        tradeCount:  trades.length,
        trades,
        // Tombstone list: driveIds deleted on this device
        tombstones:  tombstones.map(t => t.driveId),
      };

      await _upsertMasterFile(payload, folderId);

      // Mark pending trades as synced
      if (pending.length > 0) {
        await DB.markSynced(pending.map(t => t.id));
        await TradeList.load();
      }

      // Prune tombstones that have been successfully uploaded
      if (tombstones.length > 0) {
        await DB.purgeTombstones(tombstones.map(t => t.driveId));
      }

      if (!quiet) {
        Toast.show(
          pending.length > 0
            ? `${pending.length} trade(s) synced to Drive ✓`
            : 'Drive backup updated ✓',
          'success'
        );
      }

    } catch (err) {
      console.error('[DriveSync] Push error:', err);
      if (!quiet) Toast.show(`Sync failed: ${err.message}`, 'error');
    } finally {
      _syncInProgress = false;
      syncIcon?.classList.remove('spin');
      _hideSyncOverlay();
    }
  };

  /* ────────────────────────────────────────────
     _autoSync — debounced real-time push.
     Called after every trade add / edit / delete.

     • Offline → skips silently; Network 'online'
       event will push when connectivity returns.
     • Online  → waits SYNC_DEBOUNCE_MS then pushes.
     ──────────────────────────────────────────── */
  const _autoSync = () => {
    if (!_accessToken) return;
    if (!navigator.onLine) return;

    clearTimeout(_syncDebounceTimer);
    _syncDebounceTimer = setTimeout(async () => {
      await _pushSnapshot({ quiet: true });
    }, SYNC_DEBOUNCE_MS);
  };

  /* ────────────────────────────────────────────
     Drive Sync Overlay
     ──────────────────────────────────────────── */
  const _showSyncOverlay = (msg = 'Syncing to Drive…') => {
    let el = document.getElementById('driveSyncOverlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'driveSyncOverlay';
      el.innerHTML = `
        <div class="drive-sync-overlay-inner">
          <div class="drive-sync-spinner"></div>
          <p id="driveSyncMsg" class="drive-sync-msg">${msg}</p>
          <p class="drive-sync-sub">Please don't close the app</p>
        </div>`;
      document.body.appendChild(el);
    } else {
      document.getElementById('driveSyncMsg').textContent = msg;
      el.classList.remove('hidden');
    }
  };

  const _hideSyncOverlay = () => {
    const el = document.getElementById('driveSyncOverlay');
    if (el) el.classList.add('hidden');
  };

  /* ────────────────────────────────────────────
     Public aliases — kept for backward compat
     with any UI buttons calling these directly.
     ──────────────────────────────────────────── */
  const syncPendingTrades = async (opts = {}) => {
    await _fetchAndMerge({ silent: opts.quiet ?? true });
    await _pushSnapshot(opts);
  };

  const fetchExistingBackup = async (opts = {}) => _fetchAndMerge(opts);

  /* ────────────────────────────────────────────
     Public API
     ──────────────────────────────────────────── */
  return {
    connectGoogleDrive,
    syncPendingTrades,
    fetchExistingBackup,
    isConnected,
    autoSync: _autoSync,          // ← called by Modal & TradeList after every change
    _initGSI,
    _trySilentAuth,
    showSyncOverlay: _showSyncOverlay,
    hideSyncOverlay: _hideSyncOverlay,
  };
})();

/* ─────────────────────────────────────────────
   ⑨ NETWORK MODULE — Online/Offline detection
   ───────────────────────────────────────────── */
const Network = (() => {
  /** Update the network status badge in the header */
  const updateBadge = (isOnline) => {
    const badge = document.getElementById('networkBadge');
    const text  = document.getElementById('networkText');

    badge.classList.remove('badge-online', 'badge-offline');

    if (isOnline) {
      badge.classList.add('badge-online');
      text.textContent = 'Online';
    } else {
      badge.classList.add('badge-offline');
      text.textContent = 'Offline — Local Mode';
    }
  };

  /** Initialise online/offline event listeners */
  const init = () => {
    // Set initial state
    updateBadge(navigator.onLine);

    // Listen for changes
    window.addEventListener('online', async () => {
      updateBadge(true);
      Toast.show('Back online! Checking Drive for updates…', 'info');

      if (GoogleDriveSync.isConnected()) {
        // Pull latest from Drive (in case another device wrote while offline),
        // then push any locally-pending changes (including tombstones).
        await GoogleDriveSync.fetchExistingBackup({ silent: true });
        await GoogleDriveSync.syncPendingTrades({ quiet: true });
        Toast.show('Drive sync complete ✓', 'success');
      }
    });

    window.addEventListener('offline', () => {
      updateBadge(false);
      Toast.show('You are offline. Trades saved locally.', 'warn');
    });
  };

  return { init, updateBadge };
})();

/* ─────────────────────────────────────────────
   ⑩ SERVICE WORKER REGISTRATION + PWA INSTALL
   ───────────────────────────────────────────── */
const PWA = (() => {
  // Pick up any prompt already captured by the top-level listener,
  // or wait for it to arrive via __pwaReadyCallback.
  let _deferredPrompt = window.__pwaDeferred || null;
  const LS_DISMISSED  = 'fxj_install_dismissed';   // localStorage key
  const SS_DISMISSED  = 'fxj_install_dismissed_s'; // sessionStorage key (dismiss-for-session)

  /* ── Service Worker registration ── */
  const register = async () => {
    if (!('serviceWorker' in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      console.log('[PWA] Service Worker registered:', reg.scope);
    } catch (err) {
      console.info('[PWA] Service Worker not available:', err.message);
    }
  };

  /* ── Helpers ── */
  const isStandalone = () =>
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true ||
    document.referrer.includes('android-app://');

  const _showBanner = () => {
    if (isStandalone()) return;
    const banner = document.getElementById('pwaInstallBanner');
    if (banner) banner.classList.remove('hidden');
  };

  const _hideBannerAnimated = () => {
    const banner = document.getElementById('pwaInstallBanner');
    if (!banner) return;
    banner.classList.add('pwa-fade-out');
    setTimeout(() => banner.classList.add('hidden'), 260);
  };

  /* Called whenever a new deferred prompt arrives (early or late) */
  const _onPromptReady = (e) => {
    _deferredPrompt = e;

    // Safely update Settings button — it may not be defined yet if called very early
    if (typeof Settings !== 'undefined' && Settings.updateInstallBtn) {
      Settings.updateInstallBtn();
    }

    // Show banner after a short delay if user hasn't permanently dismissed
    if (!localStorage.getItem(LS_DISMISSED) && !sessionStorage.getItem(SS_DISMISSED)) {
      setTimeout(_showBanner, 1800);
    }
  };

  /* ── Public: trigger native install prompt ── */
  const triggerInstall = async () => {
    if (!_deferredPrompt) return false;
    try {
      _deferredPrompt.prompt();
      const { outcome } = await _deferredPrompt.userChoice;
      console.info('[PWA] Install outcome:', outcome);
      if (outcome === 'accepted') {
        localStorage.setItem(LS_DISMISSED, '1'); // no need to show banner again
        _hideBannerAnimated();
      }
      _deferredPrompt = null;
      // Update Settings button regardless of outcome
      if (typeof Settings !== 'undefined' && Settings.updateInstallBtn) {
        Settings.updateInstallBtn();
      }
      return outcome === 'accepted';
    } catch (err) {
      console.warn('[PWA] Install prompt error:', err);
      return false;
    }
  };

  const canInstall = () => !!_deferredPrompt;

  /* ── Wire up banner buttons + listen for late prompt / appinstalled ── */
  const _initInstallPrompt = () => {
    // Register the callback so the top-level listener can notify us
    // even if beforeinstallprompt already fired before this point
    window.__pwaReadyCallback = _onPromptReady;

    // If the prompt was captured before this init ran, process it now
    if (window.__pwaDeferred && !_deferredPrompt) {
      _onPromptReady(window.__pwaDeferred);
    } else if (_deferredPrompt) {
      // Already have it — just update button state
      if (typeof Settings !== 'undefined' && Settings.updateInstallBtn) {
        Settings.updateInstallBtn();
      }
    }

    // appinstalled fires after the user installs from the browser prompt
    window.addEventListener('appinstalled', () => {
      console.log('[PWA] App installed ✓');
      _hideBannerAnimated();
      _deferredPrompt = null;
      window.__pwaDeferred = null;
      if (typeof Settings !== 'undefined' && Settings.updateInstallBtn) {
        Settings.updateInstallBtn();
      }
    });

    // Banner Install button
    const installBtn = document.getElementById('pwaInstallBtn');
    if (installBtn) {
      installBtn.addEventListener('click', async () => {
        const accepted = await triggerInstall();
        if (!accepted && !_deferredPrompt) {
          // Prompt unavailable — guide the user
          Toast.show('Use your browser menu → "Add to Home Screen" to install.', 'info', 5000);
        }
      });
    }

    // Banner Dismiss button — hides for this session only
    const dismissBtn = document.getElementById('pwaInstallDismiss');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => {
        _hideBannerAnimated();
        sessionStorage.setItem(SS_DISMISSED, '1');
      });
    }
  };

  const init = () => {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _initInstallPrompt);
    } else {
      _initInstallPrompt();
    }
  };

  return { register, init, triggerInstall, canInstall, isStandalone };
})();


/* ─────────────────────────────────────────────
   ⑪ SETTINGS MODULE — Install PWA + Clear Cache
   ───────────────────────────────────────────── */
const Settings = (() => {

  /* ── Open / Close drawer ── */
  const open = () => {
    updateInstallBtn();
    document.getElementById('settingsOverlay').classList.remove('hidden');
    document.getElementById('settingsDrawer').classList.add('open');
    document.body.style.overflow = 'hidden';
  };

  const close = () => {
    document.getElementById('settingsOverlay').classList.add('hidden');
    document.getElementById('settingsDrawer').classList.remove('open');
    document.body.style.overflow = '';
  };

  /* ── Update Install button state based on installability ── */
  const updateInstallBtn = () => {
    const btn  = document.getElementById('settingsInstallBtn');
    const desc = document.getElementById('pwaInstallDesc');
    if (!btn) return;

    if (PWA.isStandalone()) {
      btn.textContent = 'Installed ✓';
      btn.disabled = true;
      if (desc) desc.textContent = 'App is already installed on this device';
    } else if (PWA.canInstall()) {
      btn.textContent = 'Install';
      btn.disabled = false;
      if (desc) desc.textContent = 'Add to home screen for offline use';
    } else {
      btn.textContent = 'Not Available';
      btn.disabled = true;
      if (desc) desc.textContent = 'Use browser menu → "Add to Home Screen"';
    }
  };

  /* ── Install PWA ── */
  const installPWA = async () => {
    if (!PWA.canInstall()) {
      Toast.show('Use your browser menu → "Add to Home Screen" to install.', 'info', 5000);
      return;
    }
    const accepted = await PWA.triggerInstall();
    if (accepted) {
      Toast.show('FX Journal installed successfully! ✓', 'success');
      close();
    }
  };

  /* ── Clear Cache — show confirm dialog ── */
  const confirmClearCache = () => {
    document.getElementById('clearCacheDialog').classList.remove('hidden');
  };

  const cancelClearCache = () => {
    document.getElementById('clearCacheDialog').classList.add('hidden');
  };

  /* ── Execute clear: wipe all SW caches then reload ── */
  const executeClearCache = async () => {
    cancelClearCache();
    close();

    // Cache Storage and Service Worker APIs require a secure context
    // (https:// or localhost). When the file is served from file:// the
    // origin is 'null' and both APIs throw a security error.
    const isSecure = window.isSecureContext ||
      location.protocol === 'https:' ||
      location.hostname === 'localhost' ||
      location.hostname === '127.0.0.1';

    if (!isSecure) {
      // Still do a best-effort hard reload to flush memory/http cache
      Toast.show('Cache APIs unavailable on file://  — reloading page to refresh assets.', 'info', 4000);
      setTimeout(() => window.location.reload(true), 1500);
      return;
    }

    Toast.show('Clearing cache…', 'info', 8000);

    try {
      let swCount    = 0;
      let cacheCount = 0;

      // 1. Unregister all service workers
      if ('serviceWorker' in navigator) {
        try {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(r => r.unregister()));
          swCount = regs.length;
        } catch (swErr) {
          console.warn('[Settings] SW unregister skipped:', swErr.message);
        }
      }

      // 2. Delete every Cache Storage bucket
      if ('caches' in window) {
        try {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
          cacheCount = keys.length;
          console.info('[Settings] Cleared caches:', keys);
        } catch (cacheErr) {
          console.warn('[Settings] Cache clear skipped:', cacheErr.message);
        }
      }

      Toast.show(
        `Cleared ${cacheCount} cache bucket(s), ${swCount} service worker(s). Reloading…`,
        'success', 2500
      );

      // 3. Hard reload after short delay so toast is readable
      setTimeout(() => window.location.reload(true), 1400);

    } catch (err) {
      console.error('[Settings] Clear cache error:', err);
      Toast.show('Clear cache failed: ' + err.message, 'error');
    }
  };

  return { open, close, updateInstallBtn, installPWA, confirmClearCache, cancelClearCache, executeClearCache };
})();

/* ─────────────────────────────────────────────
   ⑫ CHECKLIST MODULE — Premium 4-Section Dashboard
   ─────────────────────────────────────────────
   Replaces the 3-page wizard with a full-screen
   dashboard showing all 4 sections simultaneously
   in a responsive grid layout. Each section maps
   to a DB timeframe bucket (HTF, MTF, LTF, LTF+).
   ───────────────────────────────────────────── */
const Checklist = (() => {
  // The 4 dashboard sections. LTF+ maps to a 4th
  // DB timeframe called 'LTF+'.
  const SECTIONS = [
    { tf: 'HTF',  color: '#22d3ee', sectionId: 0 },
    { tf: 'MTF',  color: '#a78bfa', sectionId: 1 },
    { tf: 'LTF',  color: '#22c55e', sectionId: 2 },
    { tf: 'LTF+', color: '#f59e0b', sectionId: 3 },
  ];

  // Keep legacy TIMEFRAMES array for save/summary compat
  const TIMEFRAMES = SECTIONS.map(s => s.tf);

  let _items   = {};   // { HTF:[], MTF:[], LTF:[], 'LTF+':[] }
  let _checked = {};   // { [itemId]: bool }
  let _tradeId = null;
  let _date    = null;

  /* ── Helpers ── */
  const _escHtml = (s) => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const _totalChecks = () =>
    TIMEFRAMES.reduce((s, t) => s + (_items[t]||[]).filter(i => _checked[i.id]).length, 0);
  const _totalItems = () =>
    TIMEFRAMES.reduce((s, t) => s + (_items[t]||[]).length, 0);

  /* ── Parse reference tags like [22, 111] from label text ── */
  const _parseLabel = (rawLabel) => {
    // For multi-line labels: split on \n, collect ref tags from ALL lines
    const lines = rawLabel.split('\n');
    const refs = [];
    const cleanLines = lines.map(line => {
      const refMatch = line.match(/\[([0-9,\s]+)\]\s*$/);
      if (refMatch) {
        refMatch[1].split(',').map(r => r.trim()).filter(Boolean).forEach(r => refs.push(r));
        return line.slice(0, line.lastIndexOf(refMatch[0])).trim();
      }
      return line;
    });
    return { lines: cleanLines, refs };
  };

  /* ── Build a single rule row HTML ── */
  const _buildRuleHtml = (item, idx, sectionIdx, color, checked) => {
    const { lines, refs } = _parseLabel(item.label);

    // First line is the "title" line; rest are sub-lines
    const [titleLine, ...subLines] = lines;

    const refPills = refs.map(r =>
      `<span class="cl-ref-pill">${r}</span>`
    ).join('');

    const subHtml = subLines.filter(l => l.trim()).map(l =>
      `<span class="cl-dash-rule-subline">${_escHtml(l)}</span>`
    ).join('');

    return `
      <label class="cl-dash-rule${checked ? ' cl-dash-rule-checked' : ''}"
             onclick="Checklist.toggle(${item.id}, ${sectionIdx})"
             style="--rule-color:${color}">
        <!-- Custom checkbox -->
        <span class="cl-dash-checkbox${checked ? ' cl-dash-checkbox-on' : ''}"
              style="${checked ? `border-color:${color};background:${color}` : `border-color:rgba(${_hexToRgb(color)},0.35)`}">
          ${checked ? '<i class="fas fa-check" style="font-size:9px;color:#0a0f1e;"></i>' : ''}
        </span>
        <!-- Rule text block -->
        <span class="cl-dash-rule-body">
          <span class="cl-dash-rule-text${checked ? ' cl-dash-rule-text-done' : ''}">
            ${_escHtml(titleLine)}
            ${refs.length ? `<span class="cl-ref-pills">${refPills}</span>` : ''}
          </span>
          ${subHtml ? `<span class="cl-dash-rule-subs">${subHtml}</span>` : ''}
        </span>
        <!-- Status badge -->
        <span class="cl-dash-status-badge${checked ? ' cl-dash-status-valid' : ''}"
              style="${checked ? `background:${color}1a;color:${color};border-color:${color}33` : ''}">
          ${checked
            ? '<i class="fas fa-circle-check" style="font-size:9px;"></i> Valid'
            : '<i class="fas fa-clock" style="font-size:9px;"></i> Pending'}
        </span>
      </label>`;
  };

  /* ── Convert #rrggbb → "r,g,b" for rgba() ── */
  const _hexToRgb = (hex) => {
    const r = parseInt(hex.slice(1,3),16);
    const g = parseInt(hex.slice(3,5),16);
    const b = parseInt(hex.slice(5,7),16);
    return `${r},${g},${b}`;
  };

  /* ── Render one section's item list ── */
  const _renderSection = (sec) => {
    const { tf, color, sectionId } = sec;
    const items   = _items[tf] || [];
    const listEl  = document.getElementById(`clItems${sectionId}`);
    if (!listEl) return;

    if (items.length === 0) {
      listEl.innerHTML = `
        <div class="cl-empty-tf" style="padding:24px 0">
          <i class="fas fa-list-check" style="color:${color};opacity:0.35;font-size:22px;margin-bottom:8px;display:block"></i>
          <p style="color:var(--tx-faint);font-size:12px;">No rules for ${tf} yet.</p>
          <button onclick="ChecklistAdmin.open()" class="cl-link-btn" style="margin-top:8px">
            <i class="fas fa-gear mr-1"></i>Open Admin to add rules
          </button>
        </div>`;
    } else {
      listEl.innerHTML = items.map((item, idx) =>
        _buildRuleHtml(item, idx, sectionId, color, !!_checked[item.id])
      ).join('');
    }

    // Update per-section counter
    const done  = items.filter(i => _checked[i.id]).length;
    const total = items.length;
    const doneEl  = document.getElementById(`clSecDone${sectionId}`);
    const totalEl = document.getElementById(`clSecTotal${sectionId}`);
    if (doneEl)  doneEl.textContent  = done;
    if (totalEl) totalEl.textContent = total;

    // Color-code counter when fully done
    const counterEl = document.getElementById(`clSecCounter${sectionId}`);
    if (counterEl) {
      counterEl.style.color       = done === total && total > 0 ? color : 'var(--tx-muted)';
      counterEl.style.borderColor = done === total && total > 0 ? `${color}44` : 'var(--bd-faint)';
    }

    // Tint the section card when fully complete
    const sectionEl = document.getElementById(`clDashSection${sectionId}`);
    if (sectionEl) {
      if (done === total && total > 0) {
        sectionEl.style.boxShadow = `0 0 0 1.5px ${color}40, 0 4px 24px rgba(0,0,0,0.35)`;
      } else {
        sectionEl.style.boxShadow = '';
      }
    }
  };

  /* ── Build all 4 sections ── */
  const _buildAllSections = () => {
    SECTIONS.forEach(sec => _renderSection(sec));
  };

  /* ── Open ── */
  const open = async (tradeId = null, dateStr = null) => {
    _checked = {};
    _tradeId = tradeId;
    _date    = dateStr || new Date().toISOString().slice(0, 10);

    for (const sec of SECTIONS) {
      _items[sec.tf] = await DB.getChecklistItems(sec.tf);
    }
    if (tradeId) {
      const session = await DB.getChecklistSessionByTrade(tradeId);
      if (session) _checked = session.checks || {};
    }

    _buildAllSections();
    _updateProgress();

    document.getElementById('checklistModal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    // Scroll dashboard body to top on open
    const body = document.querySelector('.cl-dash-body');
    if (body) body.scrollTop = 0;
  };

  /* ── Close ── */
  const close = () => {
    document.getElementById('checklistModal').classList.add('hidden');
    document.body.style.overflow = '';
  };

  /* ── Toggle a single rule ── */
  const toggle = (itemId, sectionIndex) => {
    _checked[itemId] = !_checked[itemId];
    // Re-render just the affected section
    _renderSection(SECTIONS[sectionIndex]);
    _updateProgress();
  };

  /* ── Update global progress bar + header counter ── */
  const _updateProgress = () => {
    const done  = _totalChecks();
    const total = _totalItems();
    const pct   = total > 0 ? Math.round((done / total) * 100) : 0;

    const bar = document.getElementById('clProgressBar');
    if (bar) bar.style.width = pct + '%';

    // Header pill
    const pillText = document.getElementById('clDashProgressText');
    if (pillText) pillText.textContent = `${done} / ${total} Rules`;

    // Footer labels (also keeps legacy IDs alive)
    ['', '1', '2'].forEach(sfx => {
      const dEl = document.getElementById(`clProgressDone${sfx}`);
      const pEl = document.getElementById(`clProgressPct${sfx}`);
      if (dEl) dEl.textContent = `${done}/${total} checked`;
      if (pEl) pEl.textContent = `${pct}%`;
    });
  };

  /* ── Public: Save session (called from footer button) ── */
  const saveSession = async () => {
    try {
      const session = {
        tradeId: _tradeId,
        date:    _date,
        checks:  _checked,
        savedAt: new Date().toISOString(),
        summary: TIMEFRAMES.reduce((acc, tf) => {
          acc[tf] = {
            total: (_items[tf]||[]).length,
            done:  (_items[tf]||[]).filter(i => _checked[i.id]).length,
          };
          return acc;
        }, {}),
      };
      await DB.saveChecklistSession(session);
      Toast.show('Checklist saved ✓', 'success');
      close();
    } catch (err) {
      console.error('[Checklist] Save error:', err);
      Toast.show('Failed to save checklist.', 'error');
    }
  };

  /* ── Public: Reset all checks ── */
  const resetAll = () => {
    _checked = {};
    _buildAllSections();
    _updateProgress();
    Toast.show('Checklist reset.', 'info');
  };

  /* ── Legacy stubs (kept so keyboard handler & other code still works) ── */
  const toggle_legacy = toggle; // already exported as toggle
  const prev = () => {};        // no-op — single-page dashboard
  const next = async () => { await saveSession(); };

  return { open, close, toggle, prev, next, saveSession, resetAll };
})();

/* ─────────────────────────────────────────────
   ⑬ CHECKLIST ADMIN MODULE — Manage HTF/MTF/LTF items
   ───────────────────────────────────────────── */
const ChecklistAdmin = (() => {
  const TIMEFRAMES = ['HTF', 'MTF', 'LTF', 'LTF+'];
  const TF_COLORS  = { HTF: '#22d3ee', MTF: '#a78bfa', LTF: '#22c55e', 'LTF+': '#f59e0b' };
  let _activeTab   = 'HTF';

  const open = async () => {
    document.getElementById('clAdminModal').classList.remove('hidden');
    await _render();
  };

  const close = () => {
    document.getElementById('clAdminModal').classList.add('hidden');
  };

  const switchTab = async (tf) => {
    _activeTab = tf;
    await _render();
  };

  const _render = async () => {
    // Tab buttons
    document.getElementById('clAdminTabs').innerHTML = TIMEFRAMES.map(tf => `
      <button onclick="ChecklistAdmin.switchTab('${tf}')"
        class="cl-admin-tab ${_activeTab === tf ? 'cl-admin-tab-active' : ''}"
        style="${_activeTab === tf ? `color:${TF_COLORS[tf]};border-bottom-color:${TF_COLORS[tf]}` : ''}">
        ${tf}
      </button>`).join('');

    const items = await DB.getChecklistItems(_activeTab);
    const color = TF_COLORS[_activeTab];

    document.getElementById('clAdminItems').innerHTML = items.length === 0
      ? `<p class="text-slate-500 text-xs text-center py-6">No items yet. Add one below.</p>`
      : items.map(item => `
        <div class="cl-admin-item" data-id="${item.id}">
          <span class="cl-admin-item-dot" style="background:${color}"></span>
          <span class="cl-admin-item-label" id="clLabel-${item.id}">${_escHtml(item.label)}</span>
          <div class="cl-admin-item-actions">
            <button onclick="ChecklistAdmin.editItem(${item.id})" title="Edit"
              class="cl-admin-icon-btn hover:text-brand"><i class="fas fa-pen-to-square"></i></button>
            <button onclick="ChecklistAdmin.deleteItem(${item.id})" title="Delete"
              class="cl-admin-icon-btn hover:text-loss"><i class="fas fa-trash-can"></i></button>
          </div>
        </div>`).join('');

    // Input placeholder
    document.getElementById('clAdminInput').placeholder = `Add new ${_activeTab} item…`;
  };

  const addItem = async () => {
    const input = document.getElementById('clAdminInput');
    const label = input.value.trim();
    if (!label) { Toast.show('Enter an item description.', 'warn'); return; }
    const items = await DB.getChecklistItems(_activeTab);
    await DB.addChecklistItem({ timeframe: _activeTab, label, order: items.length });
    input.value = '';
    await _render();
    Toast.show(`${_activeTab} item added.`, 'success');
  };

  const deleteItem = async (id) => {
    if (!confirm('Delete this checklist item?')) return;
    await DB.deleteChecklistItem(id);
    await _render();
    Toast.show('Item deleted.', 'info');
  };

  const editItem = async (id) => {
    const item = await DB.raw.checklistItems.get(id);
    if (!item) return;
    const newLabel = prompt('Edit item:', item.label);
    if (newLabel === null || !newLabel.trim()) return;
    await DB.updateChecklistItem(id, { label: newLabel.trim() });
    await _render();
    Toast.show('Item updated.', 'success');
  };

  const _escHtml = (s) => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  return { open, close, switchTab, addItem, deleteItem, editItem };
})();


const App = (() => {
  const init = async () => {
    console.log('[FX Journal] Initialising…');

    try {
      // Seed default checklist items (only on first run)
      await DB.seedChecklistDefaults();

      // Network status badge + online/offline listeners
      Network.init();

      // Calendar
      await Calendar.render();

      // Trade list (default: backtest tab)
      await TradeList.load();

      // Stats
      await Stats.update();

      // Register PWA service worker
      await PWA.register();

      // Initialise PWA install prompt interception
      PWA.init();

      // ── Google Drive: init GSI and attempt silent auth ──
      // Run inside window.load so the GSI library script is fully parsed.
      // On success the callback calls _fetchAndMerge (Drive → local) then
      // _pushSnapshot (local → Drive), giving users their full history
      // automatically without any manual "Connect Drive" click.
      window.addEventListener('load', async () => {
        GoogleDriveSync._initGSI();

        if (navigator.onLine) {
          // _trySilentAuth internally calls _fetchAndMerge + _pushSnapshot
          // on success — this is the "Auto-Sync on Initialization" entry point.
          await GoogleDriveSync._trySilentAuth();
        }
      });

      console.log('[FX Journal] Ready ✓');

    } catch (err) {
      console.error('[App] Init error:', err);
      Toast.show('Failed to initialise app. Check console.', 'error');
    }
  };

  return { init };
})();

/* ── Keyboard shortcuts ── */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    Modal.close();
    Checklist.close();
    ChecklistAdmin.close();
  }
});

/* ── Boot the app ── */
document.addEventListener('DOMContentLoaded', () => App.init());
