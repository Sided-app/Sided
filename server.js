import webpush from 'web-push';

// ── Web Push VAPID ───────────────────────────────────────────────────────────
const VAPID_PUBLIC=process.env.VAPID_PUBLIC_KEY||'';
const VAPID_PRIVATE=process.env.VAPID_PRIVATE_KEY||'';
if(VAPID_PUBLIC&&VAPID_PRIVATE){
  webpush.setVapidDetails('mailto:hello@callazo.com',VAPID_PUBLIC,VAPID_PRIVATE);
  console.log('Web Push VAPID configured');
}

// Callazo — backend API (Node 18+ / Express)
// npm i express @supabase/supabase-js stripe jsonwebtoken cors
// Run: node server.js   (after setting the env vars listed at the bottom)

import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';

const {
  PORT = 3000, FOOTBALL_DATA_TOKEN,
  SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_JWT_SECRET,
  STRIPE_SECRET, STRIPE_PRICE_ID, STRIPE_WEBHOOK_SECRET,
  CRON_SECRET, APP_URL = 'https://callazo.app',
} = process.env;

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET) : null;
const app = express();
const ALLOWED_ORIGINS=['https://callazo.com','https://www.callazo.com',process.env.APP_URL].filter(Boolean);
app.use(cors({origin:(origin,cb)=>!origin||ALLOWED_ORIGINS.some(o=>origin===o||origin.endsWith('.callazo.com')||origin.includes('wesleystruik.workers.dev'))?cb(null,true):cb(null,true),credentials:true}));
// Stripe webhook needs the raw body — register before express.json()
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhook);
app.use(express.json());
app.set('trust proxy', 1); // correct client IPs behind Render's proxy
// Rate limiting: a general cap, plus a tighter cap on writes (anti-spam/abuse).
app.use('/api/', rateLimit({ windowMs: 60_000, max: 120 }));
app.use(['/api/predictions','/api/diary','/api/comments','/api/follow','/api/team-follow','/api/leagues','/api/leagues/join','/api/report','/api/block','/api/profile','/api/reactions','/api/activity','/api/leaderboard','/api/users/search'],
        rateLimit({ windowMs: 60_000, max: 25 }));

// ── small validators ──
const isInt0to99 = v => v == null || (Number.isInteger(+v) && +v >= 0 && +v <= 99);
const clean = (s, n) => String(s ?? '').trim().slice(0, n);

// ── competitions on football-data.org (others need API-Football) ──
const COMP_MAP = { 'World Cup 2026':'WC','Premier League':'PL','La Liga':'PD','Bundesliga':'BL1','Serie A':'SA','Ligue 1':'FL1','Eredivisie':'DED','Champions League':'CL','Europa League':'EL','Conference League':'ECLC','Brasileirão':'BSA','Championship':'ELC' };
const CODE2NAME = Object.fromEntries(Object.entries(COMP_MAP).map(([n,c]) => [c, n]));

async function fd(path) {
  const res = await fetch(`https://api.football-data.org/v4${path}`, { headers: { 'X-Auth-Token': FOOTBALL_DATA_TOKEN } });
  if (!res.ok) throw new Error(`football-data ${res.status} ${path}`);
  return res.json();
}

// ── API-Football (api-sports.io) for leagues football-data doesn't carry ──
const AF_LEAGUES = { 'Liga Argentina': 128, 'MLS': 253 };
const AF_OFFSET = 2_000_000_000; // keep AF fixture ids from colliding with football-data ids
const AF_SEASON = process.env.AF_SEASON || String(new Date().getFullYear());
async function af(path) {
  const res = await fetch(`https://v3.football.api-sports.io${path}`, { headers: { 'x-apisports-key': process.env.APIFOOTBALL_TOKEN } });
  if (!res.ok) throw new Error(`api-football ${res.status} ${path}`);
  return res.json();
}
function afStatus(s) { return ['FT','AET','PEN'].includes(s) ? 'FINISHED' : ['1H','2H','HT','ET','BT','LIVE','P'].includes(s) ? 'IN_PLAY' : 'SCHEDULED'; }

// ── auth middleware: ask Supabase to verify the token (no JWT secret needed) ──
async function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  const { data: { user }, error } = await db.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'unauthorized' });
  req.userId = user.id;
  next();
}

// ════════ PROFILE ════════
// Username search
app.get('/api/users/search', auth, async (req, res) => {
  const q = (req.query.q||'').toLowerCase().replace(/[^a-z0-9_]/g,'').slice(0,20);
  if(q.length<2) return res.json([]);
  const { data } = await db.from('profiles').select('user_id,username,avatar').ilike('username','%'+q+'%').limit(8);
  res.json((data||[]).filter(u=>u.user_id!==req.userId));
});
// Public leaderboard (no auth)
app.get('/api/leaderboard/public', async (req, res) => {
  const mon=new Date();mon.setDate(mon.getDate()-((mon.getDay()+6)%7));mon.setHours(0,0,0,0);
  const { data: preds } = await db.from('predictions').select('user_id,correct,points').not('correct','is',null).gte('created_at',mon.toISOString());
  const byUser={};(preds||[]).forEach(p=>{if(!byUser[p.user_id])byUser[p.user_id]={correct:0,total:0,pts:0};byUser[p.user_id].total++;if(p.correct)byUser[p.user_id].correct++;byUser[p.user_id].pts+=(p.points||0);});
  const uids=Object.keys(byUser).slice(0,20);if(!uids.length)return res.json([]);
  const {data:profs}=await db.from('profiles').select('user_id,username,avatar').in('user_id',uids);
  const rows=(profs||[]).map(p=>({name:p.username,av:p.avatar,pts:byUser[p.user_id].pts,acc:byUser[p.user_id].total?Math.round(byUser[p.user_id].correct/byUser[p.user_id].total*100):0,preds:byUser[p.user_id].total})).sort((a,b)=>b.acc-a.acc).slice(0,10);
  res.json(rows);
});
app.get('/api/profile', auth, async (req, res) => {
  const { data } = await db.from('profiles').select('*').eq('id', req.userId).maybeSingle();
  if (!data) return res.status(404).json({ error: 'no profile' });
  const { data: allPreds } = await db.from('predictions').select('correct').eq('user_id', req.userId).not('correct','is',null);
  const settled=(allPreds||[]).length, correct=(allPreds||[]).filter(p=>p.correct).length;
  const is_verified=settled>=100&&settled>0&&Math.round(correct/settled*100)>=60;
  res.json({...data, is_verified});
});
app.post('/api/profile', auth, async (req, res) => {
  const username = clean(req.body.username, 20);
  const avatar = Math.max(0, Math.min(99, parseInt(req.body.avatar) || 10));
  const fav_team = req.body.fav_team ? clean(req.body.fav_team, 40) : null;
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–20 letters, numbers or underscores.' });
  const { error } = await db.from('profiles').upsert({ id: req.userId, username, avatar: Math.max(0,Math.min(54,+avatar||10)), fav_team });
  if (error) return res.status(400).json({ error: error.message.includes('duplicate') ? 'That username is taken.' : error.message });
  if (fav_team) await db.from('team_follows').upsert({ user_id: req.userId, team: fav_team });
  res.json({ ok: true });
});

// ════════ FIXTURES (app reads from your DB) ════════
// Health check — always 200 so Render deploys never block on DB connectivity
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/fixtures', async (req, res) => {
  const { comp, from, to } = req.query;
  let q = db.from('fixtures').select('*').order('utc_date');
  if (comp) q = q.eq('competition', comp);
  if (from) q = q.gte('utc_date', from);
  if (to) q = q.lte('utc_date', to);
  const { data, error } = await q;
  if (error) { console.warn('fixtures query error:', error.message); return res.json([]); }
  res.json(data);
});

// ════════ PREDICTIONS ════════
app.post('/api/predictions', auth, async (req, res) => {
  const { fixture_id, pick, pred_home, pred_away } = req.body; // pick: 'H' | 'D' | 'A'
  if (!['H','D','A'].includes(pick)) return res.status(400).json({ error: 'invalid pick' });
  if (!isInt0to99(pred_home) || !isInt0to99(pred_away)) return res.status(400).json({ error: 'scores must be 0–99' });
  const { data: fx } = await db.from('fixtures').select('utc_date,status').eq('id', fixture_id).single();
  if (!fx) return res.status(404).json({ error: 'no fixture' });
  if (new Date(fx.utc_date) <= new Date()) return res.status(400).json({ error: 'Predictions closed — match has kicked off' });
  const conf=Math.min(5,Math.max(1,parseInt(req.body.confidence)||3));
  const { error } = await db.from('predictions').upsert(
    { user_id: req.userId, fixture_id, pick, pred_home: pred_home ?? null, pred_away: pred_away ?? null, confidence: conf, settled: false, points: null },
    { onConflict: 'user_id,fixture_id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});
// my predictions joined with fixture data (for the app to render)
app.get('/api/me/predictions', auth, async (req, res) => {
  const { data, error } = await db.from('predictions')
    .select('*, fixtures(home_team,away_team,competition,home_score,away_score,status)')
    .eq('user_id', req.userId).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json((data||[]).map(p => ({
    fixture_id: p.fixture_id, pick: p.pick, pred_home: p.pred_home, pred_away: p.pred_away,
    points: p.points, settled: p.settled,
    home_team: p.fixtures.home_team, away_team: p.fixtures.away_team, competition: p.fixtures.competition,
    home_score: p.fixtures.home_score, away_score: p.fixtures.away_score, status: p.fixtures.status })));
});

// ════════ LEADERBOARD ════════
app.get('/api/leaderboard', async (req, res) => {
  const league = req.query.league;
  if (!league) {
    // Global leaderboard from view
    const { data, error } = await db.from('leaderboard').select('*').order('points', { ascending: false }).limit(100);
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
  }
  // League-specific: calculate from predictions joined with fixtures
  const compCode = COMP_MAP[league] || league;
  const { data: fixtures } = await db.from('fixtures').select('id').eq('competition', compCode);
  if (!fixtures?.length) return res.json([]);
  const fids = fixtures.map(f => f.id);
  const { data: preds } = await db.from('predictions').select('user_id,correct,points').in('fixture_id', fids).not('correct','is',null);
  if (!preds?.length) return res.json([]);
  const byUser = {};
  (preds||[]).forEach(p => {
    if (!byUser[p.user_id]) byUser[p.user_id] = { correct: 0, total: 0, pts: 0 };
    byUser[p.user_id].total++;
    if (p.correct) byUser[p.user_id].correct++;
    byUser[p.user_id].pts += (p.points || 0);
  });
  const uids = Object.keys(byUser);
  const { data: profs } = await db.from('profiles').select('id,username,avatar').in('id', uids);
  const rows = (profs||[]).map(p => ({
    id: p.id, username: p.username, name: p.username, avatar: p.avatar, av: p.avatar,
    points: byUser[p.id].pts, pts: byUser[p.id].pts,
    accuracy: byUser[p.id].total ? Math.round(byUser[p.id].correct / byUser[p.id].total * 100) : 0,
    acc: byUser[p.id].total ? Math.round(byUser[p.id].correct / byUser[p.id].total * 100) : 0,
    settled: byUser[p.id].total, preds: byUser[p.id].total
  })).sort((a, b) => b.accuracy - a.accuracy);
  res.json(rows);
});

// ════════ FOLLOWS ════════
app.post('/api/follow', auth, async (req, res) => {
  const { followee } = req.body;
  const { data: ex } = await db.from('follows').select('*').eq('follower_id', req.userId).eq('followee_id', followee).maybeSingle();
  if (ex) await db.from('follows').delete().eq('follower_id', req.userId).eq('followee_id', followee);
  else await db.from('follows').insert({ follower_id: req.userId, followee_id: followee });
  res.json({ following: !ex });
});
app.get('/api/me/following', auth, async (req, res) => {
  const { data: f } = await db.from('follows').select('followee_id').eq('follower_id', req.userId);
  const ids = (f||[]).map(x => x.followee_id);
  if (!ids.length) return res.json([]);
  const { data: profs } = await db.from('profiles').select('id,username,avatar').in('id', ids);
  res.json(profs || []);
});
app.get('/api/user/:uid', auth, async (req, res) => {
  const uid = req.params.uid;
  const { data: prof } = await db.from('profiles').select('username,avatar,fav_team,is_verified').eq('id', uid).single();
  if (!prof) return res.status(404).json({ error: 'not found' });
  const { data: preds } = await db.from('predictions').select('correct,points').eq('user_id', uid);
  const settled = (preds || []).filter(p => p.correct !== null);
  const correct = settled.filter(p => p.correct === true).length;
  const acc = settled.length ? Math.round(correct / settled.length * 100) : 0;
  const pts = (preds || []).reduce((s, p) => s + (p.points || 0), 0);
  res.json({ id: uid, username: prof.username, avatar: prof.avatar, fav_team: prof.fav_team, is_verified: prof.is_verified||false, acc, settled: settled.length, pts });
});
app.get('/api/user/:uid/diary', auth, async (req, res) => {
  const uid = req.params.uid;
  const { data: flw } = await db.from('follows').select('id').eq('follower_id', req.userId).eq('followee_id', uid).maybeSingle();
  const vis = flw ? ['public', 'friends'] : ['public'];
  const { data } = await db.from('diary_posts').select('id,home,away,home_score,away_score,league,rating,note,visibility,created_at').eq('user_id', uid).in('visibility', vis).order('created_at', { ascending: false }).limit(20);
  res.json(data || []);
});
app.get('/api/user/:uid/predictions', auth, async (req, res) => {
  const uid = req.params.uid;
  const { data } = await db.from('predictions').select('id,pick,correct,points,created_at,fixtures(home_team,away_team,home_score,away_score,competition,status,utc_date)').eq('user_id', uid).order('created_at', { ascending: false }).limit(30);
  res.json((data || []).map(p => ({ id: p.id, pick: p.pick, correct: p.correct, points: p.points, created_at: p.created_at, h: p.fixtures?.home_team, a: p.fixtures?.away_team, hs: p.fixtures?.home_score, as: p.fixtures?.away_score, lg: p.fixtures?.competition, status: p.fixtures?.status })));
});

app.get('/api/me/teams', auth, async (req, res) => {
  const { data } = await db.from('team_follows').select('team').eq('user_id', req.userId);
  res.json((data||[]).map(r => r.team));
});
app.post('/api/team-follow', auth, async (req, res) => {
  const { team } = req.body;
  const { data: ex } = await db.from('team_follows').select('*').eq('user_id', req.userId).eq('team', team).maybeSingle();
  if (ex) await db.from('team_follows').delete().eq('user_id', req.userId).eq('team', team);
  else await db.from('team_follows').insert({ user_id: req.userId, team });
  res.json({ following: !ex });
});

// ════════ DIARY + COMMENTS ════════
app.get('/api/diary', auth, async (req, res) => {
  const { data: bl } = await db.from('blocks').select('blocked_id').eq('blocker_id', req.userId);
  const blocked = (bl || []).map(b => b.blocked_id);
  let { data, error } = await db.from('diary_posts')
    .select('*, profiles(username,avatar,is_verified), comments(body,profiles(username)), post_reactions(emoji,user_id)')
    .order('created_at', { ascending: false }).limit(80);
  if (error) return res.status(500).json({ error: error.message });
  const posts = (data || []).filter(p => !blocked.includes(p.user_id)).map(p => {
    const reactions = {};
    (p.post_reactions||[]).forEach(r => {
      if(!reactions[r.emoji]) reactions[r.emoji]={count:0,users:[]};
      reactions[r.emoji].count++;reactions[r.emoji].users.push(r.user_id);
    });
    return { ...p, reactions, post_reactions: undefined };
  });
  res.json(posts);
});
app.post('/api/diary', auth, async (req, res) => {
  const home = clean(req.body.home, 40), away = clean(req.body.away, 40);
  const rating = parseInt(req.body.rating);
  const visibility = ['private','friends','public'].includes(req.body.visibility) ? req.body.visibility : 'public';
  if (!home || !away) return res.status(400).json({ error: 'teams required' });
  if (!isInt0to99(req.body.home_score) || !isInt0to99(req.body.away_score)) return res.status(400).json({ error: 'scores must be 0–99' });
  if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'rating 1–5' });
  const match_date = req.body.match_date || null;
  const { error } = await db.from('diary_posts').insert({ user_id: req.userId, home, away, home_score: +req.body.home_score, away_score: +req.body.away_score, league: clean(req.body.league, 40), rating, note: clean(req.body.note, 280), visibility, match_date });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});
app.delete('/api/diary/:id', auth, async (req, res) => {
  const { error } = await db.from('diary_posts').delete().eq('id', req.params.id).eq('user_id', req.userId);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});
app.patch('/api/diary/:id', auth, async (req, res) => {
  const { data: post } = await db.from('diary_posts').select('user_id').eq('id', req.params.id).single();
  if (!post || post.user_id !== req.userId) return res.status(403).json({ error: 'forbidden' });
  const rating = parseInt(req.body.rating);
  if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'rating 1–5' });
  const { error } = await db.from('diary_posts').update({ home_score: +req.body.home_score, away_score: +req.body.away_score, rating, note: clean(req.body.note, 280) }).eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});
app.post('/api/comments', auth, async (req, res) => {
  const body = clean(req.body.body, 500);
  if (!body) return res.status(400).json({ error: 'empty comment' });
  const { error } = await db.from('comments').insert({ post_id: req.body.post_id, user_id: req.userId, body });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

// ── moderation: block + report (stores require these for user content) ──
app.post('/api/block', auth, async (req, res) => {
  const blocked = req.body.blocked;
  const { data: ex } = await db.from('blocks').select('*').eq('blocker_id', req.userId).eq('blocked_id', blocked).maybeSingle();
  if (ex) await db.from('blocks').delete().eq('blocker_id', req.userId).eq('blocked_id', blocked);
  else { await db.from('blocks').insert({ blocker_id: req.userId, blocked_id: blocked }); await db.from('follows').delete().eq('follower_id', req.userId).eq('followee_id', blocked); }
  res.json({ blocked: !ex });
});
app.get('/api/me/blocks', auth, async (req, res) => {
  const { data } = await db.from('blocks').select('blocked_id').eq('blocker_id', req.userId);
  res.json((data || []).map(b => b.blocked_id));
});
app.post('/api/report', auth, async (req, res) => {
  const target_type = req.body.target_type;
  if (!['post','comment','user'].includes(target_type)) return res.status(400).json({ error: 'bad target' });
  await db.from('reports').insert({ reporter_id: req.userId, target_type, target_id: String(req.body.target_id), reason: clean(req.body.reason, 300) });
  res.json({ ok: true });
});

// ════════ PRIVATE LEAGUES ════════
const code5 = () => Math.random().toString(36).slice(2, 7).toUpperCase();
app.post('/api/leagues', auth, async (req, res) => {
  const { name, competition, scope, split, entry, cash_stake } = req.body;
  const { data: prof } = await db.from('profiles').select('is_pro').eq('id', req.userId).single();
  if (!prof?.is_pro) {
    const { count } = await db.from('leagues').select('*', { count: 'exact', head: true }).eq('owner_id', req.userId);
    if (count >= 2) return res.status(403).json({ error: 'Free accounts can create up to 2 leagues. Upgrade to Pro for unlimited.' });
  }
  const { data, error } = await db.from('leagues').insert({ owner_id: req.userId, name, competition, scope, split, entry: entry ?? 100, cash_stake: cash_stake ?? null, code: code5() }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  await db.from('league_members').insert({ league_id: data.id, user_id: req.userId });
  res.json(data);
});
app.post('/api/leagues/join', auth, async (req, res) => {
  const { code } = req.body;
  const { data: lg } = await db.from('leagues').select('id').eq('code', code.toUpperCase()).maybeSingle();
  if (!lg) return res.status(404).json({ error: 'no such league' });
  await db.from('league_members').upsert({ league_id: lg.id, user_id: req.userId });
  res.json({ ok: true, league_id: lg.id });
});
app.get('/api/leagues', auth, async (req, res) => {
  const { data, error } = await db.from('league_members')
    .select('points, leagues(*, league_members(points, profiles(username,avatar)))')
    .eq('user_id', req.userId);
  if (error) return res.status(500).json({ error: error.message });
  res.json((data||[]).map(r => r.leagues));
});


// ════════ CROWD VOTE ════════
app.get('/api/fixture/:id/crowd', auth, async (req, res) => {
  const { data } = await db.from('predictions').select('pick').eq('fixture_id', req.params.id);
  const ct = {1:0,0:0,2:0}; (data||[]).forEach(p=>{if(ct[p.pick]!==undefined)ct[p.pick]++;});
  const total = Object.values(ct).reduce((s,n)=>s+n,0);
  if(!total) return res.json({home:null,draw:null,away:null,total:0});
  res.json({home:Math.round(ct[1]/total*100),draw:Math.round(ct[0]/total*100),away:Math.round(ct[2]/total*100),total});
});

// ════════ REACTIONS ════════
app.get('/api/reactions/:postId', async (req, res) => {
  const { data } = await db.from('post_reactions').select('emoji,user_id').eq('post_id', req.params.postId);
  const grouped = {};
  (data||[]).forEach(r => { if(!grouped[r.emoji]) grouped[r.emoji]={count:0,users:[]}; grouped[r.emoji].count++; grouped[r.emoji].users.push(r.user_id); });
  res.json(grouped);
});
app.post('/api/reactions', auth, async (req, res) => {
  const { post_id, emoji } = req.body;
  if(!['⚽','🔥','💀','😬','🎯'].includes(emoji)) return res.status(400).json({error:'invalid emoji'});
  const { data: ex } = await db.from('post_reactions').select('id').eq('post_id',post_id).eq('user_id',req.userId).eq('emoji',emoji).maybeSingle();
  if(ex) await db.from('post_reactions').delete().eq('id',ex.id);
  else await db.from('post_reactions').insert({post_id,user_id:req.userId,emoji});
  res.json({ok:true});
});

// ════════ ACTIVITY FEED ════════
app.get('/api/activity', auth, async (req, res) => {
  const since = new Date(Date.now()-7*864e5).toISOString();
  const { data: follows } = await db.from('follows').select('follower_id,created_at,profiles!follower_id(username,avatar)').eq('followee_id',req.userId).gte('created_at',since).order('created_at',{ascending:false}).limit(10);
  const { data: myPosts } = await db.from('diary_posts').select('id').eq('user_id',req.userId);
  const pids = (myPosts||[]).map(p=>p.id); let cmts=[];
  if(pids.length){const {data:cc}=await db.from('comments').select('body,created_at,user_id,profiles!user_id(username,avatar)').in('post_id',pids).neq('user_id',req.userId).gte('created_at',since).order('created_at',{ascending:false}).limit(10);cmts=cc||[];}
  const { data: settled } = await db.from('predictions').select('pick,correct,points,updated_at,fixtures(home_team,away_team)').eq('user_id',req.userId).not('correct','is',null).gte('updated_at',since).order('updated_at',{ascending:false}).limit(10);
  const act=[
    ...(follows||[]).map(f=>({type:'follow',user:f.profiles?.username,av:f.profiles?.avatar,uid:f.follower_id,at:f.created_at})),
    ...cmts.map(cm=>({type:'comment',user:cm.profiles?.username,av:cm.profiles?.avatar,body:cm.body,at:cm.created_at})),
    ...(settled||[]).map(p=>({type:'settle',ok:p.correct,pts:p.points,h:p.fixtures?.home_team,a:p.fixtures?.away_team,at:p.updated_at})),
  ].sort((a,b)=>new Date(b.at)-new Date(a.at)).slice(0,25);
  res.json(act);
});

// ════════ WEEKLY LEADERBOARD ════════
app.get('/api/leaderboard/week', auth, async (req, res) => {
  const mon=new Date();mon.setDate(mon.getDate()-((mon.getDay()+6)%7));mon.setHours(0,0,0,0);
  const { data: preds } = await db.from('predictions').select('user_id,correct,points').not('correct','is',null).gte('created_at',mon.toISOString());
  const byUser={};(preds||[]).forEach(p=>{if(!byUser[p.user_id])byUser[p.user_id]={correct:0,total:0,pts:0};byUser[p.user_id].total++;if(p.correct)byUser[p.user_id].correct++;byUser[p.user_id].pts+=(p.points||0);});
  const uids=Object.keys(byUser);if(!uids.length)return res.json([]);
  const {data:profs}=await db.from('profiles').select('user_id,username,avatar').in('user_id',uids);
  const rows=(profs||[]).map(p=>({id:p.user_id,name:p.username,av:p.avatar,pts:byUser[p.user_id].pts,acc:byUser[p.user_id].total?Math.round(byUser[p.user_id].correct/byUser[p.user_id].total*100):0,preds:byUser[p.user_id].total})).sort((a,b)=>b.acc-a.acc);
  res.json(rows);
});

// ════ ACCOUNT DELETION ════
app.delete('/api/account', auth, async (req, res) => {
  const uid = req.userId;
  try {
    await db.from('predictions').delete().eq('user_id', uid);
    await db.from('diary_posts').delete().eq('user_id', uid);
    await db.from('follows').delete().or(`follower_id.eq.${uid},followee_id.eq.${uid}`);
    await db.from('team_follows').delete().eq('user_id', uid);
    await db.from('post_reactions').delete().eq('user_id', uid);
    await db.from('profiles').delete().eq('id', uid);
    const { createClient } = await import('@supabase/supabase-js');
    const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {auth:{autoRefreshToken:false,persistSession:false}});
    await admin.auth.admin.deleteUser(uid);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// ════════ SYNC + AUTO-SETTLE (cron) ════════
async function runSync(src = 'all') {
  const now = Date.now();
  const from = new Date(now - 2*864e5).toISOString().slice(0,10);
  const to = new Date(now + 90*864e5).toISOString().slice(0,10);
  let upserted = 0, settled = 0;
  if (src !== 'af') for (const code of Object.values(COMP_MAP)) {
    let data; try { data = await fd(`/competitions/${code}/matches?dateFrom=${from}&dateTo=${to}${code==='WC'?'&season=2026':''}`); console.log(`fd ${code}: ${data?.matches?.length||0} matches`); } catch (e) { console.warn(`fd ${code} error: ${e.message}`); continue; }
    for (const m of data.matches || []) {
      const row = { id:m.id, competition:code, home_team:m.homeTeam.name, away_team:m.awayTeam.name, home_crest:m.homeTeam.crest||null, away_crest:m.awayTeam.crest||null, utc_date:m.utcDate, status:m.status, home_score:m.score?.fullTime?.home ?? null, away_score:m.score?.fullTime?.away ?? null, matchday:m.matchday ?? null, updated_at:new Date().toISOString() };
      const { error: uErr } = await db.from('fixtures').upsert(row);
      if (uErr) { console.error('upsert error:', uErr.message, 'row id:', row.id); continue; }
      upserted++;
      if (m.status === 'FINISHED') settled += await settleFixture(row);
    }
    await new Promise(r => setTimeout(r, 6500)); // free-tier rate limit
  }
  // API-Football leagues (Saudi, MLS, Liga MX, Liga Argentina, Jupiler)
  if (src !== 'fd' && process.env.APIFOOTBALL_TOKEN) {
    for (const [name, id] of Object.entries(AF_LEAGUES)) {
      let data; try { data = await af(`/fixtures?league=${id}&season=${AF_SEASON}&from=${from}&to=${to}`); console.log(`af ${name}: ${data?.response?.length||0} fixtures`); } catch (e) { console.warn(`af ${name} error: ${e.message}`); continue; }
      for (const m of data.response || []) {
        const status = afStatus(m.fixture.status.short);
        const row = { id: AF_OFFSET + m.fixture.id, competition: name, home_team: m.teams.home.name, away_team: m.teams.away.name, home_crest: m.teams.home.logo||null, away_crest: m.teams.away.logo||null, utc_date: m.fixture.date, status, home_score: m.goals.home, away_score: m.goals.away, matchday: null, updated_at: new Date().toISOString() };
        await db.from('fixtures').upsert(row); upserted++;
        if (status === 'FINISHED' && row.home_score != null) settled += await settleFixture(row);
      }
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  return { upserted, settled };
}

// ── Spend points (free-tier edit unlock) ──────────────────────────────────────
app.post('/api/pts/spend', auth, async (req, res) => {
  const amount = parseInt(req.body.amount) || 0;
  if (amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  const { data: prof } = await db.from('profiles').select('pts_spent').eq('id', req.userId).single();
  const current = prof?.pts_spent || 0;
  const { error } = await db.from('profiles').update({ pts_spent: current + amount }).eq('id', req.userId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, pts_spent: current + amount });
});

// ════ DEBUG ENDPOINT (remove in production) ════
app.get('/api/debug', async (req, res) => {
  const checks = { timestamp: new Date().toISOString(), env: {} };
  // Env vars
  checks.env.football_data_token = FOOTBALL_DATA_TOKEN ? `set (${FOOTBALL_DATA_TOKEN.slice(0,6)}...)` : 'MISSING';
  checks.env.apifootball_token = process.env.APIFOOTBALL_TOKEN ? `set (${process.env.APIFOOTBALL_TOKEN.slice(0,6)}...)` : 'MISSING';
  checks.env.supabase_service_key = process.env.SUPABASE_SERVICE_KEY ? 'set' : 'MISSING';
  checks.env.cron_secret = CRON_SECRET ? `set (${CRON_SECRET.slice(0,4)}...)` : 'NOT SET (sync open to all)';
  // Fixtures table check
  try { const { count, error } = await db.from('fixtures').select('*',{count:'exact',head:true}); checks.fixtures_count = error ? `ERROR: ${error.message}` : count; } catch(e) { checks.fixtures_count = `EXCEPTION: ${e.message}`; }
  // Column check
  try { const { data, error } = await db.from('fixtures').select('id,home_crest,away_crest,matchday,updated_at').limit(1); checks.fixtures_columns = error ? `MISSING COLUMNS: ${error.message}` : 'OK'; } catch(e) { checks.fixtures_columns = `ERROR: ${e.message}`; }
  // Test football-data.org PL
  try { const d = await fd('/competitions/PL/matches?dateFrom=2026-06-01&dateTo=2026-07-01'); checks.fd_PL = `OK - ${d.matches?.length||0} matches`; } catch(e) { checks.fd_PL = `ERROR: ${e.message}`; }
  // Test football-data.org WC
  try { const d = await fd('/competitions/WC/matches?dateFrom=2026-06-01&dateTo=2026-09-01&season=2026'); checks.fd_WC = `OK - ${d.matches?.length||0} matches`; } catch(e) { checks.fd_WC = `ERROR: ${e.message}`; }
  // Test API-Football WC
  if (process.env.APIFOOTBALL_TOKEN) {
    try { const d = await af(`/fixtures?league=1&season=2026&from=2026-06-01&to=2026-09-01`); checks.af_WC = `OK - ${d.response?.length||0} fixtures`; } catch(e) { checks.af_WC = `ERROR: ${e.message}`; }
  } else { checks.af_WC = 'skipped - no APIFOOTBALL_TOKEN'; }
  res.json(checks);
});
app.get('/api/sync', async (req, res) => {
  // Sync is safe to expose — it only fetches public football data
  // Protect against spam with rate limiting (already applied globally)
  try { const result=await runSync(req.query.src || 'all'); console.log('Manual sync result:', JSON.stringify(result)); res.json({ ok: true, ...result }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
async function settleFixture(fx) {
  if (fx.home_score == null) return 0;
  const result = fx.home_score > fx.away_score ? 'H' : fx.away_score > fx.home_score ? 'A' : 'D';
  const { data: preds } = await db.from('predictions').select('*').eq('fixture_id', fx.id).eq('settled', false);
  if (!preds?.length) return 0;
  for (const p of preds) {
    let pts = 0;
    const correct = p.pick === result;
    if (correct) pts += 3;
    if (p.pred_home === fx.home_score && p.pred_away === fx.away_score) pts += 2;
    await db.from('predictions').update({
      points: pts,
      settled: true,
      correct,
      home_score: fx.home_score,
      away_score: fx.away_score
    }).eq('id', p.id);
  }
  // Send push notifications
  for (const p of preds) {
    const correct = p.pick === result;
    const pts = (correct ? 3 : 0) + (p.pred_home === fx.home_score && p.pred_away === fx.away_score ? 2 : 0);
    const title = correct ? '✅ Correct call! +' + pts + 'pts' : '❌ Not this time';
    const body = `${fx.home_team} ${fx.home_score}–${fx.away_score} ${fx.away_team}`;
    sendPush(p.user_id, title, body, '/').catch(() => {});
  }
  console.log(`settled fixture ${fx.id} (${fx.home_team} vs ${fx.away_team}): ${preds.length} predictions`);
  return preds.length;
}


// ── Cron endpoint — call from UptimeRobot or external scheduler ─────────────
app.get('/api/cron', async (req, res) => {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });
  try {
    const result = await runSync();
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('cron error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Re-settle all unsettled predictions (catch-up for missed cron runs) ──────
app.post('/api/admin/resettle', async (req, res) => {
  const secret = req.headers['x-cron-secret'] || req.body?.secret;
  if (secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });
  try {
    // Get all unsettled predictions
    const { data: unsettled } = await db
      .from('predictions')
      .select('fixture_id')
      .eq('settled', false);
    if (!unsettled?.length) return res.json({ ok: true, settled: 0, message: 'nothing to settle' });

    const fxIds = [...new Set(unsettled.map(p => p.fixture_id))];
    let settled = 0;
    for (const fxId of fxIds) {
      const { data: fx } = await db.from('fixtures').select('*').eq('id', fxId).single();
      if (fx?.status === 'FINISHED' && fx.home_score != null) {
        settled += await settleFixture(fx);
      }
    }
    res.json({ ok: true, settled, checked: fxIds.length });
  } catch (e) {
    console.error('resettle error:', e);
    res.status(500).json({ error: e.message });
  }
});


// ── Push subscription ────────────────────────────────────────────────────────
app.post('/api/push-subscribe', authMw, async (req, res) => {
  const { subscription } = req.body;
  if (!subscription) return res.status(400).json({ error: 'no subscription' });
  await db.from('push_subscriptions').upsert({
    user_id: req.user.id,
    subscription: JSON.stringify(subscription),
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id' });
  res.json({ ok: true });
});

// ── Send push to a user ───────────────────────────────────────────────────────
async function sendPush(userId, title, body, url='/') {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  try {
    const { data } = await db.from('push_subscriptions').select('subscription').eq('user_id', userId).single();
    if (!data?.subscription) return;
    const sub = JSON.parse(data.subscription);
    await webpush.sendNotification(sub, JSON.stringify({ title, body, url }));
  } catch (e) {
    if (e.statusCode === 410) {
      // Subscription expired — remove it
      await db.from('push_subscriptions').delete().eq('user_id', userId);
    }
    console.warn('Push send failed for', userId, e.message);
  }
}

// ── VAPID public key endpoint (for frontend) ─────────────────────────────────
app.get('/api/vapid-public', (req, res) => {
  res.json({ key: VAPID_PUBLIC });
});

// ════════ STRIPE PRO ════════
app.post('/api/checkout', auth, async (req, res) => {
  if (!stripe || !STRIPE_PRICE_ID) return res.status(503).json({ error: 'Payments are not set up yet.' });
  const { data: profile } = await db.from('profiles').select('stripe_customer_id').eq('id', req.userId).single();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription', line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
    customer: profile?.stripe_customer_id || undefined, client_reference_id: req.userId,
    success_url: `${APP_URL}/?pro=success`, cancel_url: `${APP_URL}/?pro=cancel` });
  res.json({ url: session.url });
});
async function stripeWebhook(req, res) {
  if (!stripe) return res.status(503).end();
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET); }
  catch (e) { return res.status(400).send(`bad signature: ${e.message}`); }
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    await db.from('profiles').update({ is_pro: true, stripe_customer_id: s.customer }).eq('id', s.client_reference_id);
  }
  if (event.type === 'customer.subscription.deleted') {
    await db.from('profiles').update({ is_pro: false }).eq('stripe_customer_id', event.data.object.customer);
  }
  res.json({ received: true });
}

app.listen(PORT, () => console.log(`Callazo API on :${PORT}`));

// Self-scheduled sync — no external cron needed (set SELF_SYNC=false to disable,
// e.g. if you prefer the GitHub Action when running on a free tier that sleeps).
if (process.env.SELF_SYNC !== 'false') {
  const mins = Number(process.env.SYNC_MINUTES || 5);
  setInterval(() => runSync().then(r => console.log('sync', r)).catch(e => console.warn('sync err', e.message)), mins * 60000);
  runSync().then(r => console.log('initial sync', r)).catch(() => {});
}

/* ENV: FOOTBALL_DATA_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_JWT_SECRET,
        STRIPE_SECRET, STRIPE_PRICE_ID, STRIPE_WEBHOOK_SECRET, CRON_SECRET, APP_URL */
