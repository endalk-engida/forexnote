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
     * Delete a trade by id
     * @param {number} id - Record id
     */
    deleteTrade: async (id) => {
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
     * Upsert an array of trades from a Drive backup using their driveId as a stable key.
     * Trades whose driveId already exists locally are updated only if the remote
     * updatedAt is strictly newer; new driveIds are inserted as-is.
     *
     * @param {Object[]} remoteTrades - Array of trade objects from Drive JSON
     * @returns {Promise<{inserted:number, updated:number, skipped:number}>}
     */
    bulkUpsertTrades: async (remoteTrades) => {
      let inserted = 0, updated = 0, skipped = 0;

      for (const remote of remoteTrades) {
        if (!remote.driveId) {
          // Assign a stable driveId if the backup pre-dates this field
          remote.driveId = remote.id ? `legacy-${remote.id}` : `gen-${Date.now()}-${Math.random()}`;
        }

        const existing = await db.trades
          .where('driveId').equals(remote.driveId).first();

        if (!existing) {
          // Strip the original local id so Dexie auto-assigns a fresh one
          const { id: _drop, ...rest } = remote;
          await db.trades.add({ ...rest, syncStatus: 'synced' });
          inserted++;
        } else {
          const remoteTime = new Date(remote.updatedAt || 0).getTime();
          const localTime  = new Date(existing.updatedAt || 0).getTime();
          if (remoteTime > localTime) {
            await db.trades.update(existing.id, { ...remote, id: existing.id, syncStatus: 'synced' });
            updated++;
          } else {
            skipped++;
          }
        }
      }

      return { inserted, updated, skipped };
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
      const count = await db.checklistItems.count();
      if (count > 0) return; // already seeded
      const defaults = [
        // HTF — Higher Time Frame
        { timeframe: 'HTF', label: 'Identify overall market trend (Daily/Weekly)', order: 0 },
        { timeframe: 'HTF', label: 'Mark key support & resistance levels',         order: 1 },
        { timeframe: 'HTF', label: 'Check for major news/economic events',         order: 2 },
        { timeframe: 'HTF', label: 'Confirm HTF bias (bullish / bearish)',         order: 3 },
        // MTF — Medium Time Frame
        { timeframe: 'MTF', label: 'Confirm price is respecting HTF levels',       order: 0 },
        { timeframe: 'MTF', label: 'Identify structure shifts or BOS/CHoCH',       order: 1 },
        { timeframe: 'MTF', label: 'Locate premium / discount zones (Fibonacci)',  order: 2 },
        { timeframe: 'MTF', label: 'Wait for MTF confirmation candle',             order: 3 },
        // LTF — Lower Time Frame
        { timeframe: 'LTF', label: 'Look for entry trigger (pin bar, engulf…)',    order: 0 },
        { timeframe: 'LTF', label: 'Confirm risk-to-reward ≥ 1:2',                order: 1 },
        { timeframe: 'LTF', label: 'Set stop-loss below/above last swing',         order: 2 },
        { timeframe: 'LTF', label: 'Take the trade — journal entry ready',         order: 3 },
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

      // Auto-sync if online — show overlay so user doesn't close app mid-sync
      if (navigator.onLine && GoogleDriveSync.isConnected()) {
        await GoogleDriveSync.syncPendingTrades({ showOverlay: true });
      }

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

      // Immediately sync the deletion to Drive with overlay protection
      if (navigator.onLine && GoogleDriveSync.isConnected()) {
        await GoogleDriveSync.syncPendingTrades({ showOverlay: true, quiet: true });
      }
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
   ⑧ GOOGLE DRIVE SYNC MODULE  (v2 — multi-device recovery)
   ─────────────────────────────────────────────
   Key design decisions
   ────────────────────
   • Single canonical file  "fx-journal-master.json"  in the backup folder.
     Every successful push PATCHES (updates) that one file so Drive never
     accumulates hundreds of timestamped snapshots.
   • driveId field  — a UUID stamped onto every trade the first time it is
     written to Drive. This is the stable key used for merge / upsert across
     devices; local IndexedDB auto-increment ids are per-device and must NOT
     be used for deduplication.
   • updatedAt field — ISO timestamp bumped on every add/edit. The merge
     logic keeps whichever copy (local vs remote) has the newer updatedAt.
   • Restore flow on connect
       1. fetchExistingBackup()   — pull master file from Drive
       2. bulkUpsertTrades()      — merge into IndexedDB (newer wins)
       3. syncPendingTrades()     — push anything that is still pending
   ───────────────────────────────────────────── */
const GoogleDriveSync = (() => {
  let _accessToken = null;
  let _tokenClient = null;
  let _folderId    = null;   // cached Drive folder ID (memory only, re-fetched each session)

  // Drive file ID of fx-journal-master.json — persisted in localStorage
  // so PATCH (update-in-place) works across page reloads without an extra
  // search API call on every sync.
  const LS_MASTER_ID = 'fxj_master_file_id';
  let _masterId = localStorage.getItem(LS_MASTER_ID) || null;

  // Name of the single canonical backup file on Drive
  const MASTER_FILE = 'fx-journal-master.json';

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

        // ── On every (re-)connect: restore first, then push ──
        await _restoreFromDrive();
      },
    });
  };

  /* ────────────────────────────────────────────
     Silent token refresh — called on app init.

     GSI's implicit grant flow with prompt:'' will
     silently issue a token when the user has an
     active Google session and has previously
     granted consent. If not, the callback fires
     with an error (or, in rare cases, not at all).

     A 6-second timeout prevents the app from
     hanging if the GSI callback is never called
     (can happen in some browsers / network states).
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
          // prompt:'' = no UI interaction; errors resolve(false) gracefully
          callback:  async (response) => {
            clearTimeout(timeout);

            if (response.error || !response.access_token) {
              // Common errors: 'user_logged_out', 'interaction_required'
              // — all mean "user must click Connect Drive manually"
              console.info('[GSI] Silent auth not available:', response.error || 'no token');
              resolve(false);
              return;
            }

            _accessToken = response.access_token;
            _updateDriveButton(true);
            console.info('[GSI] Silent auth success — restoring from Drive…');

            await _restoreFromDrive({ silent: true });
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
     RESTORE — fetch master backup from Drive and
     merge into local IndexedDB.

     Algorithm:
       1. Find the master file in the app folder.
       2. Download it and parse the trades array.
       3. Compare the Drive snapshot's lastSynced
          against the local DB's latest updatedAt.
       4. If Drive is newer (or local DB is empty),
          upsert all remote trades into IndexedDB.
       5. Cache the Drive file ID for future PATCHes.

     @param {{ silent?: boolean }} opts
       silent = true → no toast banners on init
     ──────────────────────────────────────────── */
  const fetchExistingBackup = async ({ silent = false } = {}) => {
    if (!_accessToken) return null;

    try {
      const folderId = await _getOrCreateFolder();

      // Search for the master file inside our folder.
      // If we already cached the file ID, skip the search entirely.
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
        console.info(`[DriveSync] Found master backup file ID: ${masterFileId}`);
      } else {
        console.info(`[DriveSync] Using cached master file ID: ${masterFileId}`);
      }

      // Verify the file still exists (it may have been deleted on Drive)
      const checkRes = await _driveGet(
        `https://www.googleapis.com/drive/v3/files/${masterFileId}?fields=id,name,modifiedTime,trashed`
      );
      const checkData = await checkRes.json();
      if (checkData.error || checkData.trashed) {
        // File gone — clear the cached ID and report no backup
        console.warn('[DriveSync] Cached master file is missing or trashed — clearing cache.');
        _masterId = null;
        localStorage.removeItem(LS_MASTER_ID);
        if (!silent) Toast.show('No existing backup found on Drive.', 'info');
        return null;
      }

      const file = checkData;
      console.info(`[DriveSync] Master backup: ${file.name} (modified ${file.modifiedTime})`);

      // Download file content
      const dlRes = await _driveGet(
        `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`
      );
      if (!dlRes.ok) throw new Error(`Download failed (${dlRes.status})`);

      const backup = await dlRes.json();
      if (!Array.isArray(backup.trades) || backup.trades.length === 0) {
        if (!silent) Toast.show('Drive backup is empty — nothing to restore.', 'info');
        return backup;
      }

      // ── Timestamp comparison ──
      // Always run a full per-trade upsert regardless of the snapshot-level
      // timestamp, because individual trades may be newer on Drive even when
      // the Drive snapshot timestamp looks older (e.g. two devices syncing
      // out of order). The per-trade updatedAt comparison inside
      // bulkUpsertTrades is the real guard — we never skip on snapshot time alone.
      const localLatest = await DB.getLatestUpdatedAt();
      const driveLatest = backup.lastSynced || backup.exportedAt || null;

      console.info('[DriveSync] Local latest updatedAt:', localLatest);
      console.info('[DriveSync] Drive lastSynced:',       driveLatest);
      // Only skip the full upsert if local is definitively newer AND the local
      // DB already has trades (not an empty new browser session).
      const localCount  = await DB.raw.trades.count();
      const driveIsOlder = localCount > 0
        && localLatest !== null
        && driveLatest !== null
        && localLatest >= driveLatest;

      if (driveIsOlder) {
        console.info('[DriveSync] Local is current — skipping upsert.');
        if (!silent) Toast.show('Local data is up to date — no restore needed.', 'info');
        return backup;
      }

      // ── Upsert remote trades into local IndexedDB ──
      const { inserted, updated, skipped } = await DB.bulkUpsertTrades(backup.trades);

      console.info(`[DriveSync] Restore complete — inserted:${inserted} updated:${updated} skipped:${skipped}`);

      if (!silent) {
        Toast.show(
          `Drive restore: +${inserted} new, ${updated} updated, ${skipped} already current.`,
          'success',
          5000
        );
      } else if (inserted + updated > 0) {
        // On silent auto-restore, give a quiet nudge only if data actually changed
        Toast.show(`Restored ${inserted + updated} trade(s) from your Drive backup.`, 'info', 4000);
      }

      // Refresh the UI to show the newly restored data
      await Promise.all([Calendar.refresh(), TradeList.load(), Stats.update()]);

      return backup;

    } catch (err) {
      console.error('[DriveSync] Restore error:', err);
      if (!silent) Toast.show(`Restore failed: ${err.message}`, 'error');
      return null;
    }
  };

  /* ────────────────────────────────────────────
     RESTORE + PUSH — called immediately after
     any successful authentication (connect or
     silent token refresh).
     ──────────────────────────────────────────── */
  const _restoreFromDrive = async ({ silent = false } = {}) => {
    // Step 1: Pull Drive → merge local
    await fetchExistingBackup({ silent });
    // Step 2: Push anything still pending after merge
    await syncPendingTrades({ quiet: silent });
  };

  /* ────────────────────────────────────────────
     Drive Sync Overlay — shows a full-screen
     "Syncing…" blocker so users don't close the
     app mid-upload on CRUD operations.
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
     PUSH — upload all trades as the new master.

     Every trade gets a stable driveId the first
     time it is included in a push; subsequent
     pushes reuse the same driveId so the merge
     logic can reconcile across devices.

     @param {{ quiet?: boolean, showOverlay?: boolean }} opts
     ──────────────────────────────────────────── */
  const syncPendingTrades = async ({ quiet = false, showOverlay = false } = {}) => {
    if (!_accessToken) {
      if (!quiet) Toast.show('Connect Google Drive first.', 'warn');
      return;
    }

    const syncIcon = document.getElementById('syncIcon');
    syncIcon?.classList.add('spin');
    if (showOverlay) _showSyncOverlay('Syncing to Drive…');

    try {
      // Stamp driveId onto any trades that don't have one yet
      const allTrades = await DB.getTrades();

      // Nothing to back up — don't overwrite a richer Drive file with an empty payload
      if (allTrades.length === 0) {
        if (!quiet) Toast.show('No trades to sync yet.', 'info');
        return;
      }
      const needsDriveId = allTrades.filter(t => !t.driveId);
      for (const t of needsDriveId) {
        const driveId = `trade-${t.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await DB.updateTrade(t.id, { driveId });
        t.driveId = driveId;   // keep local copy in sync with what we're about to upload
      }

      // Re-fetch with driveIds populated
      const trades   = await DB.getTrades();
      const pending  = trades.filter(t => t.syncStatus === 'pending');

      const folderId = await _getOrCreateFolder();
      const now      = new Date().toISOString();

      const payload = {
        appVersion:  '2.0',
        lastSynced:  now,          // ← used by fetchExistingBackup for comparison
        tradeCount:  trades.length,
        trades,                    // full snapshot — every trade, not just pending
      };

      await _upsertMasterFile(payload, folderId);

      // Mark pending trades as synced
      if (pending.length > 0) {
        await DB.markSynced(pending.map(t => t.id));
        await TradeList.load();
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
      console.error('[DriveSync] Sync error:', err);
      if (!quiet) Toast.show(`Sync failed: ${err.message}`, 'error');
    } finally {
      syncIcon?.classList.remove('spin');
      _hideSyncOverlay();
    }
  };

  /* ────────────────────────────────────────────
     Public API
     ──────────────────────────────────────────── */
  return {
    connectGoogleDrive,
    syncPendingTrades,
    fetchExistingBackup,
    isConnected,
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
        // Restore first (in case another device wrote while we were offline),
        // then push any locally-pending trades.
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
   ⑩ SERVICE WORKER REGISTRATION
   ───────────────────────────────────────────── */
const PWA = (() => {
  const register = async () => {
    if ('serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.register('./sw.js');
        console.log('[PWA] Service Worker registered:', reg.scope);
      } catch (err) {
        // SW is optional — app works without it
        console.info('[PWA] Service Worker not available:', err.message);
      }
    }
  };

  return { register };
})();

/* ─────────────────────────────────────────────
   ⑫ CHECKLIST MODULE — HTF/MTF/LTF wizard modal
   ───────────────────────────────────────────── */
const Checklist = (() => {
  const TIMEFRAMES = ['HTF', 'MTF', 'LTF'];
  const TF_LABELS  = { HTF: 'Higher Time Frame', MTF: 'Medium Time Frame', LTF: 'Lower Time Frame' };
  const TF_ICONS   = { HTF: 'fa-chart-line', MTF: 'fa-chart-bar', LTF: 'fa-chart-simple' };
  const TF_COLORS  = { HTF: '#22d3ee', MTF: '#a78bfa', LTF: '#22c55e' };

  let _step    = 0;          // 0=HTF, 1=MTF, 2=LTF
  let _items   = {};         // { HTF:[], MTF:[], LTF:[] }
  let _checked = {};         // { [itemId]: bool }
  let _tradeId = null;       // optional linked trade id
  let _date    = null;

  /** Open the checklist wizard */
  const open = async (tradeId = null, dateStr = null) => {
    _step    = 0;
    _checked = {};
    _tradeId = tradeId;
    _date    = dateStr || new Date().toISOString().slice(0, 10);

    // Load items for all 3 timeframes
    for (const tf of TIMEFRAMES) {
      _items[tf] = await DB.getChecklistItems(tf);
    }

    // If linked trade, pre-load saved checks
    if (tradeId) {
      const session = await DB.getChecklistSessionByTrade(tradeId);
      if (session) _checked = session.checks || {};
    }

    document.getElementById('checklistModal').classList.remove('hidden');
    _render();
  };

  /** Close the wizard */
  const close = () => {
    document.getElementById('checklistModal').classList.add('hidden');
  };

  /** Render the current step */
  const _render = () => {
    const tf      = TIMEFRAMES[_step];
    const items   = _items[tf] || [];
    const color   = TF_COLORS[tf];
    const total   = TIMEFRAMES.reduce((s, t) => s + (_items[t]||[]).length, 0);
    const doneAll = TIMEFRAMES.reduce((s, t) => s + (_items[t]||[]).filter(i => _checked[i.id]).length, 0);

    // Progress bar
    const pct = total > 0 ? Math.round((doneAll / total) * 100) : 0;
    document.getElementById('clProgressBar').style.width  = pct + '%';
    document.getElementById('clProgressPct').textContent  = pct + '%';
    document.getElementById('clProgressDone').textContent = `${doneAll}/${total} checks`;

    // Step indicators
    document.getElementById('clStepIndicators').innerHTML = TIMEFRAMES.map((t, i) => {
      const done      = (_items[t]||[]).length > 0 && (_items[t]||[]).every(it => _checked[it.id]);
      const isCurrent = i === _step;
      const bg        = isCurrent ? TF_COLORS[t] : done ? '#334155' : '#1e293b';
      const textColor = isCurrent ? '#0a0f1e' : done ? '#22c55e' : '#475569';
      const border    = isCurrent ? TF_COLORS[t] : done ? '#22c55e' : '#334155';
      return `<div class="cl-step-indicator" style="background:${bg};border-color:${border};color:${textColor}">
        <i class="fas ${TF_ICONS[t]} text-xs mr-1.5"></i>${t}${done && !isCurrent ? ' <i class="fas fa-check text-[9px] ml-0.5"></i>' : ''}
      </div>`;
    }).join('<div class="cl-step-divider"></div>');

    // Title
    document.getElementById('clStepTitle').textContent = `${tf} — ${TF_LABELS[tf]}`;
    document.getElementById('clStepTitle').style.color = color;
    document.getElementById('clStepNum').textContent   = `Step ${_step + 1} of 3`;

    // Checklist items
    const doneTf = items.filter(i => _checked[i.id]).length;
    document.getElementById('clTfProgress').textContent = `${doneTf}/${items.length} done`;

    if (items.length === 0) {
      document.getElementById('clItems').innerHTML = `
        <div class="cl-empty-tf">
          <i class="fas fa-list-check text-2xl mb-2" style="color:${color};opacity:0.4"></i>
          <p>No items for ${tf} yet.</p>
          <button onclick="ChecklistAdmin.open()" class="cl-link-btn mt-2">
            <i class="fas fa-gear mr-1"></i>Open Admin to add items
          </button>
        </div>`;
    } else {
      document.getElementById('clItems').innerHTML = items.map((item, idx) => {
        const isChecked = !!_checked[item.id];
        return `<label class="cl-item ${isChecked ? 'cl-item-checked' : ''}" onclick="Checklist.toggle(${item.id}, this)">
          <span class="cl-checkbox ${isChecked ? 'cl-checkbox-checked' : ''}" style="${isChecked ? `border-color:${color};background:${color}` : ''}">
            ${isChecked ? '<i class="fas fa-check text-[10px] text-surface-900"></i>' : ''}
          </span>
          <span class="cl-item-text">${_escHtml(item.label)}</span>
          <span class="cl-item-num">${idx + 1}</span>
        </label>`;
      }).join('');
    }

    // Navigation buttons
    document.getElementById('clBtnPrev').disabled = _step === 0;
    const isLast = _step === TIMEFRAMES.length - 1;
    document.getElementById('clBtnNext').innerHTML = isLast
      ? '<i class="fas fa-floppy-disk mr-1.5"></i>Save & Finish'
      : `Next: ${TIMEFRAMES[_step + 1]} <i class="fas fa-arrow-right ml-1.5"></i>`;
    document.getElementById('clBtnNext').style.background = color;
  };

  /** Toggle a checklist item check */
  const toggle = (itemId, labelEl) => {
    _checked[itemId] = !_checked[itemId];
    _render();
  };

  /** Navigate steps */
  const prev = () => { if (_step > 0) { _step--; _render(); } };
  const next = async () => {
    if (_step < TIMEFRAMES.length - 1) {
      _step++;
      _render();
    } else {
      await _save();
    }
  };

  /** Save session to IndexedDB */
  const _save = async () => {
    try {
      const session = {
        tradeId:   _tradeId,
        date:      _date,
        checks:    _checked,
        savedAt:   new Date().toISOString(),
        summary:   TIMEFRAMES.reduce((acc, tf) => {
          acc[tf] = { total: (_items[tf]||[]).length, done: (_items[tf]||[]).filter(i => _checked[i.id]).length };
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

  const _escHtml = (s) => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  return { open, close, toggle, prev, next };
})();

/* ─────────────────────────────────────────────
   ⑬ CHECKLIST ADMIN MODULE — Manage HTF/MTF/LTF items
   ───────────────────────────────────────────── */
const ChecklistAdmin = (() => {
  const TIMEFRAMES = ['HTF', 'MTF', 'LTF'];
  const TF_COLORS  = { HTF: '#22d3ee', MTF: '#a78bfa', LTF: '#22c55e' };
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

      // Network status
      Network.init();

      // Calendar
      await Calendar.render();

      // Trade list (default: backtest tab)
      await TradeList.load();

      // Stats
      await Stats.update();

      // Google Identity Services — initialise on window load, then
      // attempt a silent token refresh so returning users get their
      // Drive data without having to click "Connect Drive" again.
      window.addEventListener('load', async () => {
        GoogleDriveSync._initGSI();

        // Try to silently re-authenticate with a cached Google session.
        // This will call fetchExistingBackup() + syncPendingTrades() on
        // success, giving the user their full trade history automatically.
        if (navigator.onLine) {
          await GoogleDriveSync._trySilentAuth();
        }
      });

      // Register PWA service worker
      await PWA.register();

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