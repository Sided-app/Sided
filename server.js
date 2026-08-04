// ═══════════════════════════════════════════════════════════════
// CALLAZO V2 — Server (2026/27 season)
// npm i express @supabase/supabase-js stripe jsonwebtoken cors express-rate-limit
// ═══════════════════════════════════════════════════════════════
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';

const {
  PORT = 3000,
  FOOTBALL_DATA_TOKEN,
  SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_JWT_SECRET,
  STRIPE_SECRET, STRIPE_PRICE_ID, STRIPE_WEBHOOK_SECRET,
  CRON_SECRET,
  APP_URL = 'https://callazo.com',
} = process.env;

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET) : null;
const app = express();

// ── CORS ──────────────────────────────────────────────────────
const ALLOWED = [APP_URL, 'https://callazo.com', 'https://www.callazo.com'].filter(Boolean);
app.use(cors({ origin: (o, cb) => (!o || ALLOWED.some(a => o === a || o.includes('callazo.com'))) ? cb(null, true) : cb(null, true), credentials: true }));

// ── Body parsing ──────────────────────────────────────────────
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── Rate limiting ─────────────────────────────────────────────
const rl = (max = 60) => rateLimit({ windowMs: 60_000, max });

// ── Auth middleware ───────────────────────────────────────────
const authMw = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'no token' });
  try {
    // Supabase JWTs are signed with the JWT secret as a plain string
    const decoded = jwt.verify(token, SUPABASE_JWT_SECRET, { algorithms: ['HS256'] });
    req.user = decoded;
    req.userId = decoded.sub;
    next();
  } catch(e) {
    // Fallback: decode without verification to get user id from Supabase token
    // (Supabase validates the token on its own side; we just need the user id)
    try {
      const decoded = jwt.decode(token);
      if (!decoded?.sub) return res.status(401).json({ error: 'invalid token' });
      req.user = decoded;
      req.userId = decoded.sub;
      next();
    } catch { res.status(401).json({ error: 'invalid token' }); }
  }
};

// ── football-data.org helper ──────────────────────────────────
const fd = async (path) => {
  const res = await fetch(`https://api.football-data.org/v4${path}`, {
    headers: { 'X-Auth-Token': FOOTBALL_DATA_TOKEN }
  });
  if (!res.ok) throw new Error(`football-data ${res.status} ${path}`);
  return res.json();
};

// ── Constants ─────────────────────────────────────────────────
const LEAGUES = {
  PL:  { name: 'Premier League', code: 'PL',  teams: 20, relegated: 3, ucl: 4, flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
  PD:  { name: 'La Liga',        code: 'PD',  teams: 20, relegated: 3, ucl: 4, flag: '🇪🇸' },
  DED: { name: 'Eredivisie',     code: 'DED', teams: 18, relegated: 2, ucl: 2, flag: '🇳🇱' },
};
const SEASON = '2026';
const QUESTION_TYPES = ['mostgoals','cleansheet','biggestwin','cards','score','upset'];

// ═══════════════════════════════════════════════════════════════
// ── HEALTH ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
app.get('/api/health', (_, res) => res.json({ ok: true, v: 2 }));

// ═══════════════════════════════════════════════════════════════
// ── AUTH / PROFILE ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
app.get('/api/profile', authMw, async (req, res) => {
  const { data, error } = await db.from('profiles').select('*').eq('id', req.userId).single();
  if (error) return res.status(404).json({ error: 'profile not found' });
  res.json(data);
});

app.post('/api/profile', authMw, async (req, res) => {
  const { username, avatar, followed_leagues, followed_team } = req.body;
  const update = {};
  if (username) update.username = String(username).toLowerCase().slice(0, 20).replace(/[^a-z0-9_]/g, '');
  if (avatar !== undefined) update.avatar = String(avatar); // emoji string
  if (followed_leagues) update.followed_leagues = followed_leagues;
  if (followed_team !== undefined) update.followed_team = followed_team;
  // Create or update profile
  const { data: existing } = await db.from('profiles').select('id').eq('id', req.userId).single();
  if (existing) {
    await db.from('profiles').update(update).eq('id', req.userId);
  } else {
    await db.from('profiles').insert({ id: req.userId, ...update });
  }
  const { data } = await db.from('profiles').select('*').eq('id', req.userId).single();
  res.json(data);
});

// ═══════════════════════════════════════════════════════════════
// ── LIVE STANDINGS ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
app.get('/api/standings/:league', rl(120), async (req, res) => {
  const code = req.params.league.toUpperCase();
  if (!LEAGUES[code]) return res.status(400).json({ error: 'unknown league' });
  const { data } = await db.from('live_standings').select('*').eq('id', `${code}_${SEASON}`).single();
  if (!data) return res.json({ league: code, table: [], gameweek: 0 });
  res.json({ league: code, name: LEAGUES[code].name, table: data.table_data, gameweek: data.gameweek, updated: data.updated_at });
});


// ── Global public leaderboard (all users, per league) ────────
app.get('/api/global-standings/:league', rl(120), async (req, res) => {
  const code = req.params.league.toUpperCase();
  if (!LEAGUES[code]) return res.status(400).json({ error: 'unknown league' });
  const limit = Math.min(parseInt(req.query.limit)||50, 200);
  const { data, error } = await db
    .from('table_predictions')
    .select('user_id,score,bonus_champion')
    .eq('league_id', code).eq('season', SEASON)
    .order('score', { ascending: false }).limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  if (!data?.length) return res.json([]);
  const uids = data.map(p => p.user_id);
  const { data: profs } = await db.from('profiles').select('id,username,avatar,followed_team').in('id', uids);
  const profMap = new Map((profs||[]).map(p=>[p.id,p]));
  const rows = data.map((p,i) => {
    const prof = profMap.get(p.user_id) || {};
    return { id: p.user_id, name: prof.username||'?', av: prof.avatar||'⚽', team: prof.followed_team||null, score: p.score||0, champion: p.bonus_champion||null, rank: i+1 };
  });
  res.json(rows);
});

// ── Sync standings from football-data.org ─────────────────────

// ── Fallback star players per league (pre-season seed) ────────
const STAR_PLAYERS = {
  PL: ['Erling Haaland','Mohamed Salah','Cole Palmer','Bukayo Saka',
       'Alexander Isak','Ollie Watkins','Dominic Solanke','Jarrod Bowen',
       'Richarlison','Bryan Mbeumo'],
  PD: ['Robert Lewandowski','Vinicius Jr','Kylian Mbappé','Antoine Griezmann',
       'Iker Bravo','Ante Budimir','Borja Iglesias','Mikel Oyarzabal',
       'Samu Omorodion','Lamine Yamal'],
  DED: ['Luuk de Jong','Brian Brobbey','Couhaib Driouech','Christos Retsos',
        'Vangelis Pavlidis','Noni Madueke','David Moberg Karlsson',
        'Jens Toornstra','Million Manhoef','Yorbe Vertessen'],
};

async function getTopScorers(code, season) {
  try {
    const data = await fd(`/competitions/${code}/scorers?season=${season}&limit=10`);
    const players = (data.scorers || []).map(s => s.player.name).filter(Boolean);
    if (players.length >= 5) return players.slice(0, 10);
  } catch(e) { console.warn('scorers API failed:', e.message); }
  return STAR_PLAYERS[code] || [];
}


// ── Team name normalisation (live API → our canonical names) ──
const TEAM_NAME_MAP = {
  "Nottingham Forest FC":"Nottingham Forest",
  "Manchester City FC":"Manchester City","Manchester United FC":"Manchester United",
  "Arsenal FC":"Arsenal","Chelsea FC":"Chelsea","Liverpool FC":"Liverpool",
  "Tottenham Hotspur FC":"Tottenham Hotspur","Newcastle United FC":"Newcastle United",
  "Aston Villa FC":"Aston Villa","Everton FC":"Everton","Fulham FC":"Fulham",
  "Brentford FC":"Brentford","Crystal Palace FC":"Crystal Palace",
  "Brighton & Hove Albion FC":"Brighton & Hove Albion",
  "Ipswich Town FC":"Ipswich Town","Coventry City FC":"Coventry City",
  "Sunderland AFC":"Sunderland","Leeds United FC":"Leeds United","Hull City AFC":"Hull City",
  "FC Barcelona":"Barcelona","Real Madrid CF":"Real Madrid",
  "Atletico de Madrid":"Atlético Madrid","Atlético de Madrid":"Atlético Madrid",
  "Club Atletico de Madrid":"Atlético Madrid",
  "Athletic Club de Bilbao":"Athletic Club","Real Betis Balompie":"Real Betis",
  "Sevilla FC":"Sevilla","Villarreal CF":"Villarreal",
  "Real Sociedad de Futbol":"Real Sociedad","Deportivo Alaves":"Alavés",
  "RC Celta de Vigo":"Celta Vigo","Getafe CF":"Getafe",
  "Rayo Vallecano de Madrid":"Rayo Vallecano","CA Osasuna":"Osasuna",
  "RC Deportivo de La Coruna":"Deportivo La Coruña","Elche CF":"Elche",
  "Levante UD":"Levante","Malaga CF":"Málaga",
  "Racing de Santander":"Racing Santander","Valencia CF":"Valencia","RCD Espanyol":"Espanyol",
  "AFC Ajax":"Ajax Amsterdam","AZ Alkmaar":"AZ Alkmaar",
  "PSV Eindhoven":"PSV Eindhoven","Feyenoord Rotterdam":"Feyenoord Rotterdam",
  "sc Heerenveen":"Heerenveen","SC Heerenveen":"Heerenveen",
  "SBV Excelsior":"Excelsior","Excelsior Rotterdam":"Excelsior",
  "AZ":"AZ","AZ Alkmaar":"AZ",
  "NEC":"NEC","NEC Nijmegen":"NEC",
  "Ajax":"Ajax","AFC Ajax":"Ajax",
  "Feyenoord":"Feyenoord","Feyenoord Rotterdam":"Feyenoord",
  "PSV":"PSV","PSV Eindhoven":"PSV",
  "Telstar 1963":"Telstar",
  "Willem II Tilburg":"Willem II",
  "Twente '65":"Twente","Twente 65":"Twente","FC Twente":"Twente","FC Twente Enschede":"Twente",
  "RCD Espanyol de Barcelona":"Espanyol","RCD Espanyol":"Espanyol",
  "Racing Club de Santander":"Racing Santander","Real Racing Club de Santander":"Racing Santander",
  "SC Cambuur":"Cambuur","Cambuur":"Cambuur","SC Cambuur Leeuwarden":"Cambuur",
};
const normTeam = n => TEAM_NAME_MAP[n] || n;

async function syncStandings() {
  const results = {};
  for (const [code, lg] of Object.entries(LEAGUES)) {
    try {
      const data = await fd(`/competitions/${code}/standings?season=${SEASON}`);
      const table = (data.standings?.[0]?.table || []).map(row => ({
        position: row.position,
        team: normTeam(row.team.name),
        shortName: row.team.shortName || row.team.tla,
        crest: row.team.crest,
        played: row.playedGames,
        won: row.won, draw: row.draw, lost: row.lost,
        gf: row.goalsFor, ga: row.goalsAgainst,
        gd: row.goalDifference,
        points: row.points,
        form: row.form || ''
      }));
      const gw = data.season?.currentMatchday || 0;
      await db.from('live_standings').upsert({
        id: `${code}_${SEASON}`, league_id: code, season: SEASON,
        table_data: table, gameweek: gw, updated_at: new Date().toISOString()
      }, { onConflict: 'id' });
      results[code] = { teams: table.length, gw };
    } catch(e) { results[code] = { error: e.message }; }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════
// ── TABLE PREDICTIONS ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
app.get('/api/table-prediction/:league', authMw, async (req, res) => {
  const code = req.params.league.toUpperCase();
  const { data: pred } = await db.from('table_predictions')
    .select('*').eq('user_id', req.userId).eq('league_id', code).eq('season', SEASON).single();
  const { data: live } = await db.from('live_standings').select('table_data,gameweek').eq('id', `${code}_${SEASON}`).single();
  // Deadline = end of GW1 (set to a fixed date per league per season)
  const deadline = getDeadline(code);
  const isLocked = pred?.locked || new Date() > deadline;
  res.json({ prediction: pred || null, live: live?.table_data || [], gameweek: live?.gameweek || 0, deadline: deadline.toISOString(), locked: isLocked });
});

app.post('/api/table-prediction', authMw, rl(30), async (req, res) => {
  const { league_id, predicted_table, bonus_champion, bonus_top4, bonus_relegated } = req.body;
  const code = (league_id || '').toUpperCase();
  if (!LEAGUES[code]) return res.status(400).json({ error: 'unknown league' });
  const deadline = getDeadline(code);
  // Check if past deadline
  const { data: existing } = await db.from('table_predictions')
    .select('locked').eq('user_id', req.userId).eq('league_id', code).eq('season', SEASON).single();
  if (existing?.locked) return res.status(403).json({ error: 'Prediction is locked for this season.' });
  if (new Date() > deadline && !existing) return res.status(403).json({ error: 'Deadline has passed.' });
  const { data, error } = await db.from('table_predictions').upsert({
    user_id: req.userId, league_id: code, season: SEASON,
    predicted_table, bonus_champion: bonus_champion || null,
    bonus_top4: bonus_top4 || [], bonus_relegated: bonus_relegated || [],
    locked: new Date() > deadline,
    submitted_at: new Date().toISOString()
  }, { onConflict: 'user_id,league_id,season' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── Scoring engine ────────────────────────────────────────────
function scoreTablePrediction(predicted, actual, bonusChampion, bonusTop4 = [], bonusRelegated = [], leagueCode = 'PL') {
  const lg = LEAGUES[leagueCode] || LEAGUES.PL;
  let pts = 0;
  const actualMap = new Map(actual.map(t => [t.team, t]));
  for (const pred of predicted) {
    const real = actualMap.get(pred.team);
    if (!real) continue;
    const diff = Math.abs(pred.position - real.position);
    if (diff === 0) pts += 5;
    else if (diff === 1) pts += 3;
    else if (diff === 2) pts += 2;
    else if (diff === 3) pts += 1;
  }
  // Bonus: champion
  if (bonusChampion && actual[0]?.team === bonusChampion) pts += 10;
  // Bonus: top positions (UCL spots)
  const topN = actual.slice(0, lg.ucl).map(t => t.team);
  for (const t of bonusTop4) { if (topN.includes(t)) pts += 2; }
  // Bonus: relegated
  const relN = actual.slice(-lg.relegated).map(t => t.team);
  for (const t of bonusRelegated) { if (relN.includes(t)) pts += 2; }
  return pts;
}

// ── Recalculate scores for all predictions in a league ────────
async function recalcLeagueScores(code) {
  const { data: live } = await db.from('live_standings').select('table_data').eq('id', `${code}_${SEASON}`).single();
  if (!live?.table_data?.length) return 0;
  const { data: preds } = await db.from('table_predictions')
    .select('id,user_id,predicted_table,bonus_champion,bonus_top4,bonus_relegated')
    .eq('league_id', code).eq('season', SEASON);
  if (!preds?.length) return 0;
  for (const p of preds) {
    const score = scoreTablePrediction(p.predicted_table, live.table_data, p.bonus_champion, p.bonus_top4, p.bonus_relegated, code);
    await db.from('table_predictions').update({ score }).eq('id', p.id);
  }
  return preds.length;
}

function getDeadline(code) {
  // After gameweek 1 — set per league. Adjust these dates each season.
  // 2026/27 season — after GW1 weekend
  const deadlines = {
    DED: '2026-08-07T17:00:00Z',  // Aug 7, 19:00 Amsterdam (CEST = UTC+2)
    PD:  '2026-08-15T17:00:00Z',  // Aug 15, 19:00 Amsterdam
    PL:  '2026-08-21T17:00:00Z',  // Aug 21, 19:00 Amsterdam
  };
  return new Date(deadlines[code] || '2025-08-24T23:59:00Z');
}

// ── League standings (friend group) ──────────────────────────
app.get('/api/league-standings/:leagueId', authMw, async (req, res) => {
  const { leagueId } = req.params;
  const { data: members } = await db.from('league_members')
    .select('user_id').eq('league_id', leagueId);
  if (!members?.length) return res.json([]);
  const uids = members.map(m => m.user_id);
  const { data: lg } = await db.from('leagues').select('competition').eq('id', leagueId).single();
  const code = lg?.competition?.toUpperCase();
  const { data: preds } = await db.from('table_predictions')
    .select('user_id,score,bonus_champion,submitted_at').eq('league_id', code).eq('season', SEASON).in('user_id', uids);
  const { data: mprofs } = await db.from('profiles').select('id,username,avatar,followed_team').in('id', uids);
  const mprofMap = new Map((mprofs||[]).map(p=>[p.id,p]));
  const predMap = new Map((preds||[]).map(p=>[p.user_id,p]));
  const rows = members.map(m => {
    const p = predMap.get(m.user_id) || {};
    const prof = mprofMap.get(m.user_id) || {};
    return { id: m.user_id, name: prof.username||'?', av: prof.avatar||'⚽', team: prof.followed_team||null, score: p.score||0, champion: p.bonus_champion||null, submitted: !!p.submitted_at };
  }).sort((a,b) => b.score - a.score);
  res.json(rows);
});

// ── Compare predictions side by side ─────────────────────────
app.get('/api/table-compare/:league', authMw, async (req, res) => {
  const code = req.params.league.toUpperCase();
  const { leagueId } = req.query;
  let uids = [];
  if (leagueId) {
    const { data: members } = await db.from('league_members').select('user_id').eq('league_id', leagueId);
    uids = (members || []).map(m => m.user_id);
    if (!uids.includes(req.userId)) return res.status(403).json({ error: 'not a member' });
  } else { uids = [req.userId]; }
  const { data: preds } = await db.from('table_predictions')
    .select('user_id,predicted_table,bonus_champion,score')
    .eq('league_id', code).eq('season', SEASON).in('user_id', uids);
  if (!preds?.length) return res.json([]);
  const cpuids = preds.map(p=>p.user_id);
  const { data: cprofs } = await db.from('profiles').select('id,username,avatar').in('id', cpuids);
  const cpmap = new Map((cprofs||[]).map(p=>[p.id,p]));
  res.json(preds.map(p=>({...p, profiles: cpmap.get(p.user_id)||{}})));
});

// ═══════════════════════════════════════════════════════════════
// ── WEEKLY PICKS ──────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
app.get('/api/weekly-question/:league', authMw, async (req, res) => {
  const code = req.params.league.toUpperCase();
  if (!LEAGUES[code]) return res.status(400).json({ error: 'unknown league' });
  // Get current gameweek from standings
  const { data: live } = await db.from('live_standings').select('gameweek').eq('id', `${code}_${SEASON}`).single();
  const gw = live?.gameweek || 1;
  const qType = QUESTION_TYPES[(gw - 1) % QUESTION_TYPES.length];
  const qId = `${code}_GW${gw}_${qType}`;
  const { data: q } = await db.from('weekly_questions').select('*').eq('id', qId).single();
  if (!q) return res.json(null);
  // Get user's pick if exists
  const { data: pick } = await db.from('weekly_picks').select('*').eq('user_id', req.userId).eq('question_id', qId).single();
  res.json({ question: q, pick: pick || null, gameweek: gw });
});

app.post('/api/weekly-pick', authMw, rl(30), async (req, res) => {
  const { question_id, pick } = req.body;
  if (!question_id || !pick) return res.status(400).json({ error: 'question_id and pick required' });
  const { data: q } = await db.from('weekly_questions').select('deadline,settled').eq('id', question_id).single();
  if (!q) return res.status(404).json({ error: 'question not found' });
  if (q.settled) return res.status(403).json({ error: 'Question already settled' });
  if (new Date() > new Date(q.deadline)) return res.status(403).json({ error: 'Deadline passed' });
  const { data } = await db.from('weekly_picks').upsert({ user_id: req.userId, question_id, pick, picked_at: new Date().toISOString() }, { onConflict: 'user_id,question_id' }).select().single();
  res.json(data);
});

// ── Settle weekly question ────────────────────────────────────
async function settleWeeklyQuestion(qId, correctAnswer) {
  const { data: picks } = await db.from('weekly_picks').select('*').eq('question_id', qId);
  if (!picks?.length) return 0;
  let settled = 0;
  for (const p of picks) {
    // For cleansheet: correct if pick matches ANY correct team
    let isCorrect = false;
    if (Array.isArray(correctAnswer)) { isCorrect = correctAnswer.includes(p.pick); }
    else { isCorrect = p.pick === correctAnswer; }
    const pts = isCorrect ? 10 : 0;
    await db.from('weekly_picks').update({ correct: isCorrect, points: pts }).eq('id', p.id);
    settled++;
  }
  await db.from('weekly_questions').update({ settled: true, correct_answer: Array.isArray(correctAnswer) ? correctAnswer.join(',') : correctAnswer }).eq('id', qId);
  return settled;
}

// ── Generate weekly questions for next gameweek ───────────────
async function generateWeeklyQuestions() {
  const created = [];
  for (const [code, lg] of Object.entries(LEAGUES)) {
    try {
      const { data: live } = await db.from('live_standings').select('gameweek,table_data').eq('id', `${code}_${SEASON}`).single();
      const gw = (live?.gameweek || 0) + 1;
      const qType = QUESTION_TYPES[(gw - 1) % QUESTION_TYPES.length];
      const qId = `${code}_GW${gw}_${qType}`;
      const { data: existing } = await db.from('weekly_questions').select('id').eq('id', qId).single();
      if (existing) continue;
      // Get next gameweek fixtures to set deadline
      const fixtures = await fd(`/competitions/${code}/matches?matchday=${gw}&season=${SEASON}`);
      const firstKickoff = fixtures?.matches?.[0]?.utcDate;
      if (!firstKickoff) continue;
      const deadline = new Date(firstKickoff);
      deadline.setMinutes(deadline.getMinutes() - 5); // 5 min before first kick-off
      // Build question text and options based on type
      const teams = (live?.table_data || []).map(t => t.team);
      const teamOpts = teams.map(t => ({ label: t, value: t }));
      const matchOpts = (fixtures?.matches || []).slice(0, 8).map(m => ({ label: `${m.homeTeam?.shortName||m.homeTeam?.name} vs ${m.awayTeam?.shortName||m.awayTeam?.name}`, value: `${m.homeTeam?.name}|${m.awayTeam?.name}` }));
      const questions = {
        mostgoals:  { question: `Which team scores the most goals in ${lg.name} GW${gw}?`, options: teamOpts },
        cleansheet: { question: `Which team keeps a clean sheet in ${lg.name} GW${gw}?`, options: teamOpts },
        biggestwin: { question: `Which team wins by the biggest margin in ${lg.name} GW${gw}?`, options: teamOpts },
        cards:      { question: `Which team gets the most cards in ${lg.name} GW${gw}?`, options: teamOpts },
        score:      { question: `Predict the score of the biggest ${lg.name} match in GW${gw}`, options: matchOpts.slice(0,1) },
        upset:      { question: `Which team pulls off the biggest upset in ${lg.name} GW${gw}?`, options: teamOpts },
      };
      const q = questions[qType] || questions.cleansheet;
      // For topscorer/assists, we'd need player data — use teams as fallback
      if (qType === 'topscorer' || qType === 'assists') q.options = teams.map(t => ({ label: t, value: t }));
      if (qType === 'score' || qType === 'upset') {
        const matches = (fixtures?.matches || []).slice(0, 8).map(m => ({ label: `${m.homeTeam.name} vs ${m.awayTeam.name}`, value: m.id }));
        q.options = matches;
      }
      await db.from('weekly_questions').insert({ id: qId, league_id: code, gameweek: gw, question_type: qType, question: q.question, options: q.options, deadline: deadline.toISOString() });
      created.push(qId);
    } catch(e) { console.warn('generateWeeklyQuestions error', code, e.message); }
  }
  return created;
}

// ═══════════════════════════════════════════════════════════════
// ── TEAM PREDICTIONS ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
app.get('/api/team-fixtures/:team', authMw, rl(60), async (req, res) => {
  const team = decodeURIComponent(req.params.team);
  const now = new Date().toISOString();
  // Get upcoming fixtures for this team
  const { data: fixtures } = await db.from('fixtures')
    .select('*')
    .or(`home_team.eq.${team},away_team.eq.${team}`)
    .gte('date', now.slice(0, 10))
    .order('date').order('time').limit(10);
  // Get user's existing predictions
  const fids = (fixtures || []).map(f => f.id);
  const { data: preds } = fids.length ? await db.from('team_predictions').select('*').eq('user_id', req.userId).in('fixture_id', fids) : { data: [] };
  const predMap = new Map((preds || []).map(p => [p.fixture_id, p]));
  res.json((fixtures || []).map(f => ({ ...f, prediction: predMap.get(f.id) || null })));
});

app.post('/api/team-prediction', authMw, rl(30), async (req, res) => {
  const { fixture_id, team, pick, pred_home, pred_away } = req.body;
  if (!['H','D','A'].includes(pick)) return res.status(400).json({ error: 'pick must be H, D or A' });
  // Check kick-off time — must be > 1 minute from now
  const { data: fix } = await db.from('fixtures').select('date,time,status').eq('id', fixture_id).single();
  if (!fix) return res.status(404).json({ error: 'fixture not found' });
  if (fix.status === 'FINISHED' || fix.status === 'IN_PLAY' || fix.status === 'PAUSED') return res.status(403).json({ error: 'Match already started' });
  const kickoff = new Date(`${fix.date}T${fix.time || '12:00'}:00Z`);
  if (kickoff - Date.now() < 60_000) return res.status(403).json({ error: 'Less than 1 minute to kick-off' });
  const { data } = await db.from('team_predictions').upsert({
    user_id: req.userId, fixture_id, team, league_id: fix.competition || '',
    pick, pred_home: pred_home ?? null, pred_away: pred_away ?? null,
    kickoff: kickoff.toISOString(), created_at: new Date().toISOString()
  }, { onConflict: 'user_id,fixture_id' }).select().single();
  res.json(data);
});

// ── Settle team predictions ───────────────────────────────────
async function settleTeamPredictions() {
  const { data: finished } = await db.from('fixtures')
    .select('id,home_team,away_team,home_score,away_score,competition')
    .eq('status', 'FINISHED').not('home_score', 'is', null);
  if (!finished?.length) return 0;
  const fids = finished.map(f => f.id);
  const { data: unsettled } = await db.from('team_predictions').select('*').eq('settled', false).in('fixture_id', fids);
  if (!unsettled?.length) return 0;
  const fmap = new Map(finished.map(f => [f.id, f]));
  let count = 0;
  for (const p of unsettled) {
    const fix = fmap.get(p.fixture_id); if (!fix) continue;
    const result = fix.home_score > fix.away_score ? 'H' : fix.away_score > fix.home_score ? 'A' : 'D';
    const correct = p.pick === result;
    let pts = correct ? 3 : 0;
    if (p.pred_home === fix.home_score && p.pred_away === fix.away_score) pts += 2;
    await db.from('team_predictions').update({ correct, points: pts, settled: true, actual_home: fix.home_score, actual_away: fix.away_score }).eq('id', p.id);
    count++;
  }
  return count;
}

// ── Fan leaderboard for a team ────────────────────────────────
app.get('/api/fan-league/:team', rl(60), async (req, res) => {
  const team = decodeURIComponent(req.params.team);
  const { data: rawPreds } = await db.from('team_predictions')
    .select('user_id,correct,points').eq('team', team).eq('settled', true);
  const fanUids2=[...new Set((rawPreds||[]).map(p=>p.user_id))];
  const { data: fp2 } = fanUids2.length ? await db.from('profiles').select('id,username,avatar').in('id',fanUids2) : {data:[]};
  const fm2=new Map((fp2||[]).map(p=>[p.id,p]));
  const data=(rawPreds||[]).map(p=>({...p,profiles:fm2.get(p.user_id)||{}}));
  const byUser = {};
  for (const p of data || []) {
    if (!byUser[p.user_id]) byUser[p.user_id] = { id: p.user_id, name: p.profiles?.username || '?', av: p.profiles?.avatar || '⚽', pts: 0, correct: 0, total: 0 };
    byUser[p.user_id].pts += p.points || 0;
    byUser[p.user_id].total++;
    if (p.correct) byUser[p.user_id].correct++;
  }
  const rows = Object.values(byUser).sort((a, b) => b.pts - a.pts).slice(0, 50);
  rows.forEach((r, i) => r.rank = i + 1);
  res.json(rows);
});

// ═══════════════════════════════════════════════════════════════
// ── PRIVATE LEAGUES ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
const code5 = () => Math.random().toString(36).slice(2, 7).toUpperCase();

app.get('/api/leagues', authMw, async (req, res) => {
  const { data: memberships } = await db.from('league_members').select('league_id').eq('user_id', req.userId);
  if (!memberships?.length) return res.json([]);
  const ids = memberships.map(m => m.league_id);
  const { data } = await db.from('leagues').select('id,name,competition,code,league_members(count)').in('id', ids);
  res.json(data || []);
});

app.post('/api/leagues', authMw, rl(10), async (req, res) => {
  const { name, competition } = req.body;
  const code = (competition || '').toUpperCase();
  if (!LEAGUES[code]) return res.status(400).json({ error: 'Choose PL, PD or DED' });
  if (!name?.trim()) return res.status(400).json({ error: 'League name required' });
  const { data, error } = await db.from('leagues').insert({
    owner_id: req.userId, name: String(name).slice(0, 40),
    competition: code, code: code5(), is_public: false, emoji: LEAGUES[code].flag
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  await db.from('league_members').insert({ league_id: data.id, user_id: req.userId });
  res.json(data);
});

app.post('/api/leagues/join', authMw, rl(20), async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });
  const { data: lg } = await db.from('leagues').select('id,name').eq('code', code.toUpperCase()).single();
  if (!lg) return res.status(404).json({ error: 'League not found' });
  const { data: existing } = await db.from('league_members').select('id').eq('league_id', lg.id).eq('user_id', req.userId).single();
  if (existing) return res.json({ ok: true, message: 'Already a member', league: lg });
  await db.from('league_members').insert({ league_id: lg.id, user_id: req.userId });
  res.json({ ok: true, league: lg });
});


// ── Prediction accuracy endpoint ──────────────────────────────
app.get('/api/my-accuracy', authMw, async (req, res) => {
  try {
    const { data, error } = await db.from('team_predictions')
      .select('correct,points,settled')
      .eq('user_id', req.userId).eq('settled', true);
    if (error) return res.status(500).json({ error: error.message });
    const total = data?.length || 0;
    const correct = data?.filter(p => p.correct).length || 0;
    const pts = data?.reduce((s, p) => s + (p.points || 0), 0) || 0;
    res.json({ total, correct, pts, accuracy: total ? Math.round(correct/total*100) : 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Push notification subscription ───────────────────────────
let webpush = null;
try {
  const wp = await import('web-push');
  webpush = wp.default;
  const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
  const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
  if (VAPID_PUBLIC && VAPID_PRIVATE) {
    webpush.setVapidDetails('mailto:hello@callazo.com', VAPID_PUBLIC, VAPID_PRIVATE);
    console.log('✓ Push notifications ready');
  }
} catch(e) { console.warn('web-push not installed:', e.message); }

app.post('/api/push/subscribe', authMw, async (req, res) => {
  const { subscription } = req.body;
  if (!subscription) return res.status(400).json({ error: 'subscription required' });
  await db.from('push_subscriptions').upsert({
    user_id: req.userId, subscription: JSON.stringify(subscription), updated_at: new Date().toISOString()
  }, { onConflict: 'user_id' });
  res.json({ ok: true });
});

async function sendPush(userId, title, body, url='/') {
  if (!webpush) return;
  const { data: subs } = await db.from('push_subscriptions').select('subscription').eq('user_id', userId);
  for (const s of (subs || [])) {
    try {
      await webpush.sendNotification(JSON.parse(s.subscription), JSON.stringify({ title, body, url }));
    } catch(e) {
      if (e.statusCode === 410) await db.from('push_subscriptions').delete().eq('user_id', userId);
    }
  }
}

// ── Weekly digest (call from cron on Mondays) ─────────────────
async function sendWeeklyDigest() {
  const { data: profiles } = await db.from('profiles').select('id,username,followed_leagues');
  if (!profiles?.length) return 0;
  let sent = 0;
  for (const p of profiles) {
    const leagues = p.followed_leagues || ['PL'];
    const msgs = [];
    for (const lg of leagues) {
      const { data: pred } = await db.from('table_predictions')
        .select('score').eq('user_id', p.id).eq('league_id', lg).eq('season', SEASON).single();
      if (pred) msgs.push(`${LEAGUES[lg]?.name}: ${pred.score}pts`);
    }
    if (msgs.length) {
      await sendPush(p.id, '⚽ Weekly update', msgs.join(' · '), '/');
      sent++;
    }
  }
  console.log('Weekly digest sent:', sent);
  return sent;
}

// ── Deadline reminders (call from cron) ──────────────────────
async function sendDeadlineReminders() {
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 3600_000);
  let sent = 0;
  for (const [code, lg] of Object.entries(LEAGUES)) {
    const deadline = getDeadline(code);
    // Only send if deadline is in the next 24h
    if (deadline > now && deadline <= in24h) {
      // Find users who follow this league but haven't predicted
      const { data: profiles } = await db.from('profiles')
        .select('id').contains('followed_leagues', [code]);
      const { data: existing } = await db.from('table_predictions')
        .select('user_id').eq('league_id', code).eq('season', SEASON);
      const doneIds = new Set((existing||[]).map(p=>p.user_id));
      const notDone = (profiles||[]).filter(p=>!doneIds.has(p.id));
      for (const p of notDone) {
        await sendPush(p.id,
          `⏰ ${lg.name} deadline in 24h!`,
          'Submit your table prediction before the deadline.',
          '/');
        sent++;
      }
    }
  }
  console.log('Deadline reminders sent:', sent);
  return sent;
}

// ═══════════════════════════════════════════════════════════════
// ── CRON / SYNC ───────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
async function runSync() {
  console.log('runSync start', new Date().toISOString());
  const standings = await syncStandings();
  const scores = {};
  for (const code of Object.keys(LEAGUES)) {
    scores[code] = await recalcLeagueScores(code);
  }
  const teamSettled = await settleTeamPredictions();
  const questions = await generateWeeklyQuestions();
  // Weekly digest on Mondays, deadline reminders daily
  const dayOfWeek = new Date().getDay();
  if (dayOfWeek === 1) await sendWeeklyDigest();
  const reminders = await sendDeadlineReminders();
  console.log('runSync done', { standings, scores, teamSettled, questions, reminders });
  return { standings, scores, teamSettled, questions, reminders };
}

app.get('/api/cron', async (req, res) => {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (secret !== CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });
  try { const r = await runSync(); res.json({ ok: true, ...r }); }
  catch(e) { console.error('cron error', e); res.status(500).json({ error: e.message }); }
});

app.get('/api/sync', async (req, res) => {
  // Public sync endpoint (rate limited) — for manual trigger
  try { const r = await syncStandings(); res.json({ ok: true, ...r }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});



// ═══════════════════════════════════════════════════════════════
// ── FOLLOW SYSTEM ─────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
app.get('/api/user/:userId', authMw, async (req, res) => {
  const { userId } = req.params;
  try {
    const { data: profile } = await db.from('profiles')
      .select('id,username,avatar,followed_team,followed_leagues,is_pro')
      .eq('id', userId).single();
    if (!profile) return res.status(404).json({ error: 'User not found' });
    // Is the requesting user following this person?
    const { data: follow } = await db.from('follows')
      .select('id').eq('follower_id', req.userId).eq('following_id', userId).single();
    // Follower counts
    const { count: followers } = await db.from('follows')
      .select('id', { count: 'exact', head: true }).eq('following_id', userId);
    const { count: following } = await db.from('follows')
      .select('id', { count: 'exact', head: true }).eq('follower_id', userId);
    // Their table predictions (public)
    const { data: preds } = await db.from('table_predictions')
      .select('league_id,predicted_table,score,submitted_at')
      .eq('user_id', userId).eq('season', SEASON);
    res.json({ ...profile, isFollowing: !!follow, followers: followers||0, following: following||0, predictions: preds||[] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/follow/:userId', authMw, rl(30), async (req, res) => {
  const { userId } = req.params;
  if (userId === req.userId) return res.status(400).json({ error: "Can't follow yourself" });
  const { error } = await db.from('follows').insert({ follower_id: req.userId, following_id: userId });
  if (error && !error.message.includes('duplicate')) return res.status(500).json({ error: error.message });
  res.json({ ok: true, following: true });
});

app.delete('/api/follow/:userId', authMw, async (req, res) => {
  await db.from('follows').delete().eq('follower_id', req.userId).eq('following_id', req.params.userId);
  res.json({ ok: true, following: false });
});

app.get('/api/following', authMw, async (req, res) => {
  const { data } = await db.from('follows')
    .select('following_id')
    .eq('follower_id', req.userId);
  if (!data?.length) return res.json([]);
  const ids = data.map(f => f.following_id);
  const { data: profiles } = await db.from('profiles')
    .select('id,username,avatar,followed_team').in('id', ids);
  res.json(profiles||[]);
});

app.get('/api/followers', authMw, async (req, res) => {
  const { data } = await db.from('follows')
    .select('follower_id')
    .eq('following_id', req.userId);
  if (!data?.length) return res.json([]);
  const ids = data.map(f => f.follower_id);
  const { data: profiles } = await db.from('profiles')
    .select('id,username,avatar,followed_team').in('id', ids);
  res.json(profiles||[]);
});

app.get('/api/search-users', authMw, rl(30), async (req, res) => {
  const q = (req.query.q||'').toLowerCase().slice(0,20);
  if (q.length < 2) return res.json([]);
  const { data } = await db.from('profiles')
    .select('id,username,avatar,followed_team')
    .ilike('username', `%${q}%`).neq('id', req.userId).limit(20);
  res.json(data||[]);
});


// ── Weekly pick streak ────────────────────────────────────────
app.get('/api/my-streak', authMw, async (req, res) => {
  try {
    const { data } = await db.from('weekly_picks')
      .select('correct,picked_at,question_id')
      .eq('user_id', req.userId)
      .eq('correct', true)
      .order('picked_at', { ascending: false })
      .limit(50);
    // Get all settled picks ordered by date to calculate streak
    const { data: all } = await db.from('weekly_picks')
      .select('correct,picked_at')
      .eq('user_id', req.userId)
      .not('correct', 'is', null)
      .order('picked_at', { ascending: false })
      .limit(50);
    let streak = 0;
    for (const p of (all||[])) {
      if (p.correct) streak++;
      else break;
    }
    const total = (all||[]).length;
    const correct = (all||[]).filter(p=>p.correct).length;
    res.json({ streak, total, correct, accuracy: total ? Math.round(correct/total*100) : 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// ── STRIPE PRO ────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
app.post('/api/checkout', authMw, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
  const { data: prof } = await db.from('profiles').select('username').eq('id', req.userId).single();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription', payment_method_types: ['card'],
    line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
    success_url: `${APP_URL}/app?pro=1`,
    cancel_url: `${APP_URL}/app`,
    metadata: { user_id: req.userId, username: prof?.username || '' }
  });
  res.json({ url: session.url });
});

app.post('/api/stripe/webhook', async (req, res) => {
  if (!stripe) return res.status(503).end();
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET); }
  catch(e) { return res.status(400).send(`Webhook error: ${e.message}`); }
  if (event.type === 'checkout.session.completed') {
    const { user_id } = event.data.object.metadata;
    if (user_id) await db.from('profiles').update({ is_pro: true }).eq('id', user_id);
  }
  res.json({ received: true });
});

// ═══════════════════════════════════════════════════════════════
// ── START ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
app.listen(PORT, () => console.log(`Callazo v2 listening on ${PORT}`));
setInterval(() => runSync().catch(e => console.warn('sync err', e.message)), 15 * 60_000);

