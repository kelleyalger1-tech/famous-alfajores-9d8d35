/**
 * ATMOS MARKET — Supabase Integration Layer
 * atmos-supabase.js
 *
 * Drop this file alongside atmos-market.html.
 * Add to HTML head: <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *                   <script src="atmos-supabase.js"></script>
 *
 * Set your project values below (from Supabase Dashboard → Settings → API)
 */

// ─── CONFIG ───────────────────────────────────────────────
const SUPABASE_URL  = window.ATMOS_CONFIG?.SUPABASE_URL  || '';
const SUPABASE_ANON = window.ATMOS_CONFIG?.SUPABASE_ANON || '';

if (!SUPABASE_URL) console.warn('[ATMOS] Supabase not configured — auth disabled. Add config.js with ATMOS_CONFIG.');
const db = SUPABASE_URL ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON) : null;

// ─── AUTH STATE ───────────────────────────────────────────
let currentUser  = null;
let userProfile  = null;

/**
 * Boot: check for existing session, wire auth state listener.
 * Call once on app init before anything else.
 */
async function atmosAuthInit() {
  const { data: { session } } = await db.auth.getSession();
  if (session?.user) await onSignIn(session.user);

  db.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN')  await onSignIn(session.user);
    if (event === 'SIGNED_OUT') onSignOut();
  });
}

async function onSignIn(user) {
  currentUser = user;
  userProfile = await fetchProfile(user.id);
  renderAuthUI();
  await loadRemoteSessions();         // pull saved sessions from DB
  await loadRemoteKalshiCredMeta();   // restore key_id + env (not the key itself)
  await restoreRemotePushSubs();      // re-register push sub if it exists
  showToast('SIGNED IN', `Welcome back, ${userProfile?.display_name || user.email}`, 'win');
}

function onSignOut() {
  currentUser = null;
  userProfile  = null;
  renderAuthUI();
  showToast('SIGNED OUT', 'Session ended.', 'info');
}

// ─── AUTH METHODS ─────────────────────────────────────────

/** Magic link — user gets email, clicks it, done. No password. */
async function signInMagicLink(email) {
  const { error } = await db.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin }
  });
  if (error) throw error;
}

/** Email + password */
async function signInPassword(email, password) {
  const { error } = await db.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

async function signUpPassword(email, password, displayName) {
  const { error } = await db.auth.signUp({
    email, password,
    options: { data: { name: displayName } }
  });
  if (error) throw error;
}

/** Google OAuth — redirects then returns */
async function signInGoogle() {
  const { error } = await db.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin }
  });
  if (error) throw error;
}

/** Apple OAuth */
async function signInApple() {
  const { error } = await db.auth.signInWithOAuth({
    provider: 'apple',
    options: { redirectTo: window.location.origin }
  });
  if (error) throw error;
}

async function signOut() {
  await db.auth.signOut();
}

// ─── PROFILE ──────────────────────────────────────────────
async function fetchProfile(userId) {
  const { data, error } = await db
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  if (error) { console.error('Profile fetch failed:', error); return null; }
  return data;
}

async function updateProfile(updates) {
  if (!currentUser) return;
  const { error } = await db
    .from('profiles')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', currentUser.id);
  if (error) throw error;
  userProfile = { ...userProfile, ...updates };
}

// ─── SESSIONS ─────────────────────────────────────────────

/**
 * Save the current session to Supabase.
 * Also saves a compressed balance_history array for chart reconstruction.
 */
async function saveSessionRemote(sessionData) {
  if (!currentUser) {
    // Not signed in — fall back to localStorage (existing behaviour)
    return false;
  }

  const { data, error } = await db
    .from('sessions')
    .insert({
      user_id:         currentUser.id,
      start_balance:   sessionData.startBalance,
      end_balance:     sessionData.endBalance,
      total_trades:    sessionData.trades,
      total_wins:      sessionData.wins,
      best_streak:     sessionData.bestStreak,
      max_bonus_pct:   sessionData.maxBonus * 100,
      balance_history: sessionData.balanceHistory,
      weather_source:  sessionData.weatherSource || 'simulated',
      duration_secs:   sessionData.durationSecs || null,
    })
    .select()
    .single();

  if (error) { console.error('Session save failed:', error); return false; }
  return data;
}

/**
 * Load all sessions for the current user, newest first.
 * Merges with any locally cached sessions.
 */
async function loadRemoteSessions() {
  if (!currentUser) return;

  const { data, error } = await db
    .from('sessions')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) { console.error('Sessions load failed:', error); return; }

  // Normalise to match the local session shape atmos-market.html expects
  perfSessions = data.map(s => ({
    id:           s.id,
    date:         new Date(s.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'2-digit' }),
    time:         new Date(s.created_at).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' }),
    startBalance: parseFloat(s.start_balance),
    endBalance:   parseFloat(s.end_balance),
    pnl:          parseFloat(s.end_balance) - parseFloat(s.start_balance),
    trades:       s.total_trades,
    wins:         s.total_wins,
    winRate:      parseFloat(s.win_rate),
    bestStreak:   s.best_streak,
    balanceHistory: s.balance_history || [],
  }));
}

async function deleteSession(sessionId) {
  if (!currentUser) return;
  const { error } = await db
    .from('sessions')
    .delete()
    .eq('id', sessionId)
    .eq('user_id', currentUser.id); // RLS double-check
  if (error) throw error;
}

// ─── INDIVIDUAL TRADE LOGGING ─────────────────────────────

/**
 * Log a single trade after execution.
 * Call this inside executeTrade() after the outcome is determined.
 */
async function logTradeRemote(sessionId, tradeData) {
  if (!currentUser || !sessionId) return;

  await db.from('trades').insert({
    session_id:      sessionId,
    user_id:         currentUser.id,
    market_city:     tradeData.city,
    market_type:     tradeData.type,
    market_question: tradeData.question,
    direction:       tradeData.direction,
    bet_amount:      tradeData.betAmount,
    win_prob:        tradeData.prob,
    base_payout:     tradeData.basePayout,
    streak_bonus:    tradeData.streakBonus,
    effective_mult:  tradeData.effectiveMult,
    outcome:         tradeData.outcome,
    pnl:             tradeData.pnl,
    balance_after:   tradeData.balanceAfter,
    streak_after:    tradeData.streakAfter,
    is_live_data:    tradeData.isLive,
  });
}

// ─── KALSHI CREDENTIALS ───────────────────────────────────

/**
 * Save Kalshi key_id + environment to DB.
 * The PRIVATE KEY never leaves the device — it lives in:
 *   - Browser: sessionStorage (cleared on tab close)
 *   - Mobile: React Native Keychain (secure enclave)
 *
 * We only persist the key_id (public identifier) so we know
 * which Kalshi key to reference when telling the user to sign.
 */
async function saveKalshiCredMeta(keyId, environment, label) {
  if (!currentUser) return;

  const { error } = await db
    .from('kalshi_credentials')
    .upsert({
      user_id:     currentUser.id,
      key_id:      keyId,
      environment,
      label:       label || null,
      updated_at:  new Date().toISOString(),
    }, { onConflict: 'user_id' });

  if (error) throw error;
}

async function markKalshiVerified() {
  if (!currentUser) return;
  await db
    .from('kalshi_credentials')
    .update({ verified: true, verified_at: new Date().toISOString() })
    .eq('user_id', currentUser.id);
}

async function loadRemoteKalshiCredMeta() {
  if (!currentUser) return;

  const { data, error } = await db
    .from('kalshi_credentials')
    .select('key_id, environment, label, verified')
    .eq('user_id', currentUser.id)
    .single();

  if (error || !data) return;

  // Pre-fill the UI fields (not the private key — user must re-enter that)
  const keyIdEl = document.getElementById('k-key-id');
  if (keyIdEl) keyIdEl.value = data.key_id;
  if (data.environment) setEnv(data.environment);

  // If previously verified, show partial connected state
  if (data.verified) {
    const apiNote = document.querySelector('.k-api-note');
    if (apiNote) apiNote.innerHTML += `<br><span style="color:var(--green)">✓ Key ID on file — enter your private key to reconnect</span>`;
  }
}

async function deleteKalshiCreds() {
  if (!currentUser) return;
  await db.from('kalshi_credentials').delete().eq('user_id', currentUser.id);
}

// ─── POSITIONS ────────────────────────────────────────────

async function upsertPositions(positions) {
  if (!currentUser || !positions.length) return;

  const rows = positions.map(p => ({
    user_id:       currentUser.id,
    ticker:        p.ticker,
    title:         p.title || null,
    side:          p.side,
    contracts:     p.contracts,
    entry_price:   p.entryPrice,
    current_price: p.currentPrice || null,
    unrealized_pnl: p.unrealizedPnl || null,
    synced_at:     new Date().toISOString(),
  }));

  const { error } = await db
    .from('positions')
    .upsert(rows, { onConflict: 'user_id,ticker' });

  if (error) console.error('Positions sync failed:', error);
}

async function fetchPositions() {
  if (!currentUser) return [];

  const { data, error } = await db
    .from('positions')
    .select('*')
    .eq('user_id', currentUser.id);

  if (error) return [];
  return data;
}

async function clearClosedPosition(ticker) {
  if (!currentUser) return;
  await db.from('positions').delete()
    .eq('user_id', currentUser.id)
    .eq('ticker', ticker);
}

// ─── PUSH SUBSCRIPTIONS ───────────────────────────────────

async function savePushSubRemote(subscription, deviceId, prefs) {
  if (!currentUser) return;

  const sub = subscription.toJSON ? subscription.toJSON() : subscription;

  const { error } = await db
    .from('push_subscriptions')
    .upsert({
      user_id:     currentUser.id,
      device_id:   deviceId,
      platform:    'web',
      endpoint:    sub.endpoint,
      p256dh:      sub.keys?.p256dh,
      auth_key:    sub.keys?.auth,
      pref_markets_open:  prefs?.markets  ?? true,
      pref_skew_alert:    prefs?.skew     ?? true,
      pref_lockin_alert:  prefs?.lockin   ?? true,
      pref_warning_5min:  prefs?.warning  ?? true,
      last_seen_at: new Date().toISOString(),
    }, { onConflict: 'user_id,device_id' });

  if (error) console.error('Push sub save failed:', error);
}

async function updatePushPrefsRemote(prefs) {
  if (!currentUser) return;
  await db.from('push_subscriptions')
    .update({
      pref_markets_open: prefs.markets,
      pref_skew_alert:   prefs.skew,
      pref_lockin_alert: prefs.lockin,
      pref_warning_5min: prefs.warning,
    })
    .eq('user_id', currentUser.id)
    .eq('device_id', deviceId);
}

async function restoreRemotePushSubs() {
  // Touch last_seen_at so the server knows this device is still active
  if (!currentUser) return;
  await db.from('push_subscriptions')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('user_id', currentUser.id)
    .eq('device_id', deviceId);
}

// ─── REALTIME SUBSCRIPTIONS ───────────────────────────────

/**
 * Subscribe to position changes in realtime.
 * When the server updates a position's current_price (from Kalshi polling),
 * the app receives it instantly without polling.
 */
function subscribeToPositionUpdates(callback) {
  if (!currentUser) return null;

  return db
    .channel('positions-' + currentUser.id)
    .on('postgres_changes', {
      event:  '*',
      schema: 'public',
      table:  'positions',
      filter: `user_id=eq.${currentUser.id}`,
    }, payload => callback(payload))
    .subscribe();
}

// ─── AUTH UI ──────────────────────────────────────────────

/**
 * Renders the auth panel in the Kalshi sidebar.
 * Shows sign-in form when logged out, profile info when logged in.
 */
function renderAuthUI() {
  const el = document.getElementById('auth-panel-content');
  if (!el) return;

  if (currentUser) {
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);margin-bottom:10px">
        <div style="width:32px;height:32px;border-radius:50%;background:var(--green-faint);border:1px solid var(--green-dim);display:flex;align-items:center;justify-content:center;font-family:'Orbitron',monospace;font-size:12px;color:var(--green)">
          ${(userProfile?.display_name || currentUser.email || '?')[0].toUpperCase()}
        </div>
        <div style="flex:1">
          <div style="font-size:10px;color:var(--green)">${userProfile?.display_name || 'TRADER'}</div>
          <div style="font-size:9px;color:var(--text-dim)">${currentUser.email}</div>
        </div>
        <button class="k-btn k-btn-dim" style="font-size:8px;padding:4px 8px" onclick="signOut()">SIGN OUT</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
        <div class="k-stat"><div class="k-stat-lbl">All-Time Trades</div><div class="k-stat-val" style="font-size:16px">${userProfile?.lifetime_trades ?? 0}</div></div>
        <div class="k-stat"><div class="k-stat-lbl">Peak Balance</div><div class="k-stat-val amber" style="font-size:16px">$${parseFloat(userProfile?.lifetime_high_balance ?? 1000).toFixed(0)}</div></div>
        <div class="k-stat"><div class="k-stat-lbl">Best Streak</div><div class="k-stat-val" style="font-size:16px">${userProfile?.lifetime_best_streak ?? 0}🔥</div></div>
        <div class="k-stat"><div class="k-stat-lbl">Sessions</div><div class="k-stat-val" style="font-size:16px" id="auth-session-count">—</div></div>
      </div>`;
    // async fill session count
    db.from('sessions').select('id', { count: 'exact', head: true })
      .eq('user_id', currentUser.id)
      .then(({ count }) => {
        const el = document.getElementById('auth-session-count');
        if (el) el.textContent = count ?? 0;
      });
  } else {
    el.innerHTML = `
      <div style="color:var(--text-dim);font-size:9px;letter-spacing:1px;margin-bottom:10px">SIGN IN TO SYNC DATA ACROSS DEVICES</div>
      <input class="k-input" id="auth-email" placeholder="your@email.com" type="email" style="margin-bottom:8px">
      <div class="k-btn-row" style="margin-bottom:8px">
        <button class="k-btn k-btn-green" onclick="handleMagicLink()">MAGIC LINK ✉</button>
      </div>
      <div style="text-align:center;color:var(--text-dim);font-size:9px;margin:6px 0">— OR —</div>
      <div class="k-btn-row">
        <button class="k-btn k-btn-dim" style="flex:1" onclick="signInGoogle()">G  GOOGLE</button>
        <button class="k-btn k-btn-dim" style="flex:1" onclick="signInApple()"> APPLE</button>
      </div>
      <div style="font-size:9px;color:var(--text-dim);margin-top:8px;line-height:1.6">
        Magic link: enter email, click the link we send. No password ever created.
      </div>`;
  }
}

async function handleMagicLink() {
  const email = document.getElementById('auth-email')?.value?.trim();
  if (!email) { showToast('ENTER EMAIL', 'Type your email address first.', 'info'); return; }
  try {
    await signInMagicLink(email);
    showToast('LINK SENT', `Check ${email} for your sign-in link.`, 'win', 5000);
  } catch (e) {
    showToast('SEND FAILED', e.message, 'loss');
  }
}

// ─── OVERRIDES: saveCurrentSession + clearAllSessions ─────
// These replace the localStorage-only versions in atmos-market.html

const _originalSave = typeof saveCurrentSession !== 'undefined' ? saveCurrentSession : null;

async function saveCurrentSession() {
  if (totalBets === 0) { showToast('NO TRADES YET', 'Place at least one trade first.', 'info'); return; }

  const sessionData = {
    startBalance:   startBalance,
    endBalance:     parseFloat(balance.toFixed(2)),
    trades:         totalBets,
    wins:           totalWins,
    bestStreak:     bestStreak,
    maxBonus:       maxBonus,
    balanceHistory: [...balanceHistory],
    weatherSource:  document.getElementById('weather-source')?.textContent?.includes('LIVE') ? 'live' : 'simulated',
  };

  if (currentUser) {
    // Save to Supabase
    const saved = await saveSessionRemote(sessionData);
    if (saved) {
      showToast('SESSION SAVED', `+$${(sessionData.endBalance - sessionData.startBalance).toFixed(2)} · ${Math.round(sessionData.wins/Math.max(sessionData.trades,1)*100)}% win rate`, sessionData.endBalance >= sessionData.startBalance ? 'win' : 'loss');
      await loadRemoteSessions();
      renderPerformance();
      return;
    }
  }

  // Not signed in — fall back to localStorage
  const local = {
    id: Date.now(),
    date: new Date().toLocaleDateString('en-US', { month:'short', day:'numeric', year:'2-digit' }),
    time: new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' }),
    ...sessionData,
    pnl: sessionData.endBalance - sessionData.startBalance,
    winRate: Math.round(sessionData.wins / Math.max(sessionData.trades,1) * 100),
  };
  perfSessions.unshift(local);
  if (perfSessions.length > 50) perfSessions = perfSessions.slice(0, 50);
  localStorage.setItem('atmos-sessions', JSON.stringify(perfSessions));
  showToast('SESSION SAVED (LOCAL)', 'Sign in to sync across devices.', 'info');
  renderPerformance();
}

async function clearAllSessions() {
  if (!confirm('Clear all session history? This cannot be undone.')) return;
  if (currentUser) {
    const { error } = await db.from('sessions').delete().eq('user_id', currentUser.id);
    if (error) { showToast('DELETE FAILED', error.message, 'loss'); return; }
  }
  perfSessions = [];
  localStorage.removeItem('atmos-sessions');
  renderPerformance();
  showToast('HISTORY CLEARED', 'All session data removed.', 'info');
}

// ─── INIT ─────────────────────────────────────────────────
// Call this from atmos-market.html init block:
//   atmosAuthInit();
