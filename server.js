require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const morgan    = require('morgan');
const rateLimit = require('express-rate-limit');
const admin     = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');

// ─── FIREBASE INIT ────────────────────────────────────────────────────────
function initFirebase() {
  if (admin.apps.length > 0) return;
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:    process.env.FIREBASE_PROJECT_ID,
      privateKeyId: process.env.FIREBASE_PRIVATE_KEY_ID,
      privateKey:   process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      clientEmail:  process.env.FIREBASE_CLIENT_EMAIL,
      clientId:     process.env.FIREBASE_CLIENT_ID,
    }),
  });
  console.log('✅ Firebase conectado:', process.env.FIREBASE_PROJECT_ID);
}

initFirebase();
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

// ─── APP ──────────────────────────────────────────────────────────────────
const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS: origem não permitida'));
  },
  methods: ['GET','POST','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Api-Token'],
}));
app.options('*', cors());

app.use(rateLimit({ windowMs: 15*60*1000, max: 200 }));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────
function requireToken(req, res, next) {
  const token = req.headers['x-api-token'] || req.headers['authorization']?.replace('Bearer ','') || req.query.token;
  if (!token || token !== process.env.API_SECRET_TOKEN) {
    return res.status(401).json({ error: 'Token inválido.' });
  }
  next();
}

// ─── HELPERS ─────────────────────────────────────────────────────────────
function detectSource(utm_source, utm_medium) {
  const src = (utm_source||'').toLowerCase();
  const med = (utm_medium||'').toLowerCase();
  if (src.includes('google') || med === 'cpc' || med === 'ppc') return 'Google Ads';
  if (src.includes('facebook') || src.includes('fb') || src.includes('instagram') || src.includes('meta')) return 'Meta Ads';
  return 'Orgânico';
}

// ─── ROTAS PÚBLICAS ───────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => res.json({ service: 'BHI CRM API', status: 'online', timestamp: new Date().toISOString() }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Captura de lead (widget do site — sem autenticação)
const captureLimiter = rateLimit({ windowMs: 60*1000, max: 15 });

app.post('/api/leads', captureLimiter, async (req, res) => {
  try {
    // Aceita variações de campos (Greatpages, Meta Ads, Google Ads, manual)
    const nome     = req.body.nome     || req.body.Nome     || req.body.name     || req.body.Name     || '';
    const telefone = req.body.telefone || req.body.Whatsapp || req.body.whatsapp || req.body.phone    || req.body.Phone    || req.body.celular  || '';
    const utm_source   = req.body.utm_source   || req.body['UTM source']   || req.body.utmSource   || '';
    const utm_medium   = req.body.utm_medium   || req.body['UTM medium']   || req.body.utmMedium   || '';
    const utm_campaign = req.body.utm_campaign || req.body['UTM campaign'] || req.body.utmCampaign || '';
    const utm_content  = req.body.utm_content  || req.body['UTM content']  || req.body.utmContent  || '';
    const utm_term     = req.body.utm_term     || req.body['UTM term']     || req.body.utmTerm     || '';
    const pagina       = req.body.pagina       || req.body.URL             || req.body.url         || '';

    console.log('📥 Lead recebido:', JSON.stringify(req.body));

    if (!nome || !telefone) return res.status(400).json({ error: 'Nome e telefone obrigatórios.', received: req.body });

    const phone = String(telefone).replace(/\D/g,'');
    if (phone.length < 8) return res.status(400).json({ error: 'Telefone inválido.' });

    // Verifica duplicata (24h)
    const ontem = new Date(Date.now() - 86400000).toISOString();
    const dup = await db.collection('leads').where('phone','==',phone).where('createdAt','>',ontem).limit(1).get();
    if (!dup.empty) {
      return res.status(200).json({ success: true, leadId: dup.docs[0].id, duplicado: true });
    }

    // Atribuição automática ao vendedor com menos leads
    let responsavelId = null;
    const vendedoresSnap = await db.collection('users').where('perfil','==','vendedor').where('ativo','==',true).get();
    if (!vendedoresSnap.empty) {
      const vendedores = vendedoresSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const contagens = await Promise.all(vendedores.map(async v => {
        const s = await db.collection('leads').where('resp','==',v.id).where('status','in',['novo','atendimento','agendado']).get();
        return { id: v.id, count: s.size };
      }));
      contagens.sort((a,b) => a.count - b.count);
      responsavelId = contagens[0].id;
    }

    const leadId = uuidv4();
    const lead = {
      id: leadId, nome: nome.trim(), phone,
      source: detectSource(utm_source, utm_medium),
      campaign: utm_campaign || '',
      utm: { source: utm_source||'', medium: utm_medium||'', campaign: utm_campaign||'', content: utm_content||'', term: utm_term||'' },
      pagina: pagina || '', status: 'novo', nivel: 'medio', resp: responsavelId, obs: '',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };

    await db.collection('leads').doc(leadId).set(lead);
    await db.collection('activities').add({ texto: `Novo lead <strong>${nome}</strong> via ${lead.source}`, cor: '#4285f4', createdAt: new Date().toISOString() });
    await db.collection('interactions').add({ leadId, texto: `Lead capturado via ${lead.source}${utm_campaign ? ` — campanha: ${utm_campaign}` : ''}`, autor: 'Sistema', tipo: 'captura', createdAt: new Date().toISOString() });

    console.log(`✅ Lead: ${nome} (${phone}) — ${lead.source}`);
    return res.status(201).json({ success: true, leadId });

  } catch (err) {
    console.error('❌ Erro lead:', err);
    return res.status(500).json({ error: 'Erro interno.' });
  }
});

// ─── ROTAS PROTEGIDAS ─────────────────────────────────────────────────────

// Listar leads
app.get('/api/leads', requireToken, async (req, res) => {
  try {
    const { status, source, nivel, resp, limit = 200 } = req.query;
    let q = db.collection('leads').orderBy('createdAt','desc').limit(Number(limit));
    if (status) q = q.where('status','==',status);
    if (source) q = q.where('source','==',source);
    if (nivel)  q = q.where('nivel','==',nivel);
    if (resp)   q = q.where('resp','==',resp);
    const snap = await q.get();
    const leads = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ success: true, total: leads.length, leads });
  } catch (err) { return res.status(500).json({ error: 'Erro ao buscar leads.' }); }
});

// Detalhe de um lead
app.get('/api/leads/:id', requireToken, async (req, res) => {
  try {
    const doc = await db.collection('leads').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Lead não encontrado.' });
    const intSnap = await db.collection('interactions').where('leadId','==',req.params.id).orderBy('createdAt','asc').get();
    return res.json({ success: true, lead: { id: doc.id, ...doc.data() }, interactions: intSnap.docs.map(d => d.data()) });
  } catch (err) { return res.status(500).json({ error: 'Erro ao buscar lead.' }); }
});

// Atualizar lead
app.patch('/api/leads/:id', requireToken, async (req, res) => {
  try {
    const allowed = ['nome','phone','status','nivel','resp','obs','campaign'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    updates.updatedAt = new Date().toISOString();
    await db.collection('leads').doc(req.params.id).update(updates);
    if (req.body.status) {
      const doc = await db.collection('leads').doc(req.params.id).get();
      await db.collection('activities').add({ texto: `<strong>${doc.data()?.nome}</strong> movido para <em>${req.body.status}</em>`, cor: '#C9A96E', createdAt: new Date().toISOString() });
    }
    return res.json({ success: true, updated: updates });
  } catch (err) { return res.status(500).json({ error: 'Erro ao atualizar.' }); }
});

// Deletar lead
app.delete('/api/leads/:id', requireToken, async (req, res) => {
  try {
    await db.collection('leads').doc(req.params.id).delete();
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: 'Erro ao deletar.' }); }
});

// Adicionar interação
app.post('/api/leads/:id/interactions', requireToken, async (req, res) => {
  try {
    const { texto, autor, tipo = 'manual' } = req.body;
    if (!texto) return res.status(400).json({ error: 'Texto obrigatório.' });
    const ref = await db.collection('interactions').add({ leadId: req.params.id, texto, autor: autor||'Sistema', tipo, createdAt: new Date().toISOString() });
    return res.status(201).json({ success: true, id: ref.id });
  } catch (err) { return res.status(500).json({ error: 'Erro ao registrar.' }); }
});

// Login
app.post('/api/users/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ error: 'E-mail e senha obrigatórios.' });
    const snap = await db.collection('users').where('email','==',email).where('senha','==',senha).limit(1).get();
    if (snap.empty) return res.status(401).json({ error: 'Credenciais inválidas.' });
    const user = { id: snap.docs[0].id, ...snap.docs[0].data() };
    delete user.senha;
    return res.json({ success: true, user, token: process.env.API_SECRET_TOKEN });
  } catch (err) { return res.status(500).json({ error: 'Erro ao autenticar.' }); }
});

// Listar usuários
app.get('/api/users', requireToken, async (req, res) => {
  try {
    const snap = await db.collection('users').orderBy('nome').get();
    const users = snap.docs.map(d => { const u = { id: d.id, ...d.data() }; delete u.senha; return u; });
    return res.json({ success: true, users });
  } catch (err) { return res.status(500).json({ error: 'Erro ao buscar usuários.' }); }
});

// Criar usuário
app.post('/api/users', requireToken, async (req, res) => {
  try {
    const { nome, email, senha, perfil = 'vendedor', wa } = req.body;
    if (!nome || !email || !senha) return res.status(400).json({ error: 'Nome, e-mail e senha obrigatórios.' });
    const dup = await db.collection('users').where('email','==',email).limit(1).get();
    if (!dup.empty) return res.status(409).json({ error: 'E-mail já cadastrado.' });
    const ref = await db.collection('users').add({ nome, email, senha, perfil, wa: wa||'', avatar: nome.charAt(0).toUpperCase(), ativo: true, createdAt: new Date().toISOString() });
    return res.status(201).json({ success: true, id: ref.id });
  } catch (err) { return res.status(500).json({ error: 'Erro ao criar usuário.' }); }
});

// Métricas dashboard
app.get('/api/dashboard/metrics', requireToken, async (req, res) => {
  try {
    const [leadsSnap, activSnap] = await Promise.all([
      db.collection('leads').get(),
      db.collection('activities').orderBy('createdAt','desc').limit(10).get(),
    ]);
    const leads = leadsSnap.docs.map(d => d.data());
    const porStatus = {}, porSource = {}, porNivel = {};
    leads.forEach(l => {
      porStatus[l.status] = (porStatus[l.status]||0) + 1;
      porSource[l.source] = (porSource[l.source]||0) + 1;
      porNivel[l.nivel]   = (porNivel[l.nivel]||0) + 1;
    });
    const fechados = porStatus['fechado']||0;
    return res.json({ success: true, metrics: { total: leads.length, porStatus, porSource, porNivel, conversao: leads.length > 0 ? Math.round((fechados/leads.length)*100) : 0, receita: fechados * 20000 }, activities: activSnap.docs.map(d => d.data()) });
  } catch (err) { return res.status(500).json({ error: 'Erro métricas.' }); }
});

// ─── 404 ──────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: `Rota não encontrada: ${req.method} ${req.path}` }));
app.use((err, req, res, _next) => { console.error('💥', err.message); res.status(500).json({ error: err.message }); });

// ─── START ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 BHI CRM API — porta ${PORT}`);
  console.log(`   Ambiente: ${process.env.NODE_ENV||'development'}\n`);
});

module.exports = app;
