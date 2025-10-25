import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';
import { generateVisitPDFBuffer } from './pdf.js';
import nodemailer from 'nodemailer';

const app = express();

// --- Strong CORS (explicit) ---
app.use((req,res,next)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(cors());
app.use(express.json());

// Health
app.get('/api/health', (req,res)=> res.json({ok:true, ts: Date.now()}));

// DB pool
const pool = await mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

// Simple DB ping
app.get('/api/pingdb', async (req,res)=>{
  try {
    const [rows] = await pool.query('SELECT 1 AS ok');
    res.json({db:true, rows});
  } catch (e) {
    res.status(500).json({db:false, error: e.message});
  }
});

const auth = (roles = []) => (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    if (roles.length && !roles.includes(payload.role)) return res.status(403).json({msg:'forbidden'});
    next();
  } catch {
    return res.status(401).json({msg:'unauthorized'});
  }
};

// Login
app.post('/api/auth/login', async (req,res)=>{
  try{
    const {email, password} = req.body||{};
    const [rows] = await pool.query(
      'SELECT u.id, u.full_name, u.email, u.phone, r.name AS role, u.password_hash FROM users u JOIN roles r ON r.id=u.role_id WHERE email=? AND is_active=1',
      [email]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({msg:'invalid'});
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({msg:'invalid'});
    const token = jwt.sign({id:user.id, role:user.role, name:user.full_name}, process.env.JWT_SECRET, {expiresIn:'12h'});
    res.json({ token, user: {id:user.id, name:user.full_name, email:user.email, phone:user.phone, role:user.role} });
  }catch(e){
    res.status(500).json({msg:'login_error', error: e.message});
  }
});

// Companies/Branches/Recipients
app.get('/api/companies', auth(['admin','manager','employee']), async (req,res)=>{
  const [rows] = await pool.query('SELECT * FROM companies ORDER BY name');
  res.json(rows);
});

app.get('/api/branches', auth(['admin','manager','employee']), async (req,res)=>{
  const [rows] = await pool.query('SELECT * FROM branches ORDER BY name');
  res.json(rows);
});

app.get('/api/branches/:id/recipients', auth(['admin','manager','employee']), async (req,res)=>{
  const [rows] = await pool.query('SELECT * FROM branch_recipients WHERE branch_id=? ORDER BY id',[req.params.id]);
  res.json(rows);
});

// Tasks
app.get('/api/tasks', auth(['admin','manager','employee']), async (req,res)=>{
  const [rows] = await pool.query('SELECT * FROM tasks WHERE is_active=1 ORDER BY sort_order, id');
  res.json(rows);
});

// Visits
app.post('/api/visits/start', auth(['employee','manager','admin']), async (req,res)=>{
  const { branch_id } = req.body || {};
  if (!branch_id) return res.status(400).json({msg:'branch_id required'});
  const [r] = await pool.query('INSERT INTO visits(branch_id, employee_id, started_at) VALUES(?,?,NOW())', [branch_id, req.user.id]);
  res.json({ visit_id: r.insertId, started_at: new Date().toISOString() });
});

app.post('/api/visits/:id/end', auth(['employee','manager','admin']), async (req,res)=>{
  await pool.query('UPDATE visits SET ended_at=NOW() WHERE id=? AND employee_id=?', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

app.put('/api/visits/:id/cash', auth(['employee','manager','admin']), async (req,res)=>{
  const { system_balance=0, actual_balance=0, sales_amount=0 } = req.body || {};
  await pool.query(`INSERT INTO visit_cash(visit_id, system_balance, actual_balance, sales_amount)
                    VALUES(?,?,?,?)
                    ON DUPLICATE KEY UPDATE system_balance=VALUES(system_balance), actual_balance=VALUES(actual_balance), sales_amount=VALUES(sales_amount)`,
                    [req.params.id, system_balance, actual_balance, sales_amount]);
  res.json({ ok: true });
});

app.post('/api/visits/:id/inventory', auth(['employee','manager','admin']), async (req,res)=>{
  const items = req.body.items || [];
  if (!Array.isArray(items) || !items.length) return res.status(400).json({msg:'no items'});
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const sql = 'INSERT INTO visit_inventory_items(visit_id,item_name,color,size,system_qty,actual_qty) VALUES (?,?,?,?,?,?)';
    for (const it of items) {
      await conn.query(sql, [req.params.id, it.item_name, it.color||null, it.size||null, it.system_qty||0, it.actual_qty||0]);
    }
    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({msg:'db error'});
  } finally {
    conn.release();
  }
});

app.post('/api/visits/:id/notes', auth(['employee','manager','admin']), async (req,res)=>{
  const { note_text } = req.body || {};
  if (!note_text) return res.status(400).json({msg:'note_text required'});
  await pool.query('INSERT INTO visit_notes(visit_id, note_text) VALUES(?,?)', [req.params.id, note_text]);
  res.json({ ok: true });
});

app.post('/api/visits/:id/submit', auth(['employee']), async (req,res)=>{
  await pool.query("UPDATE visits SET status='submitted' WHERE id=? AND employee_id=?", [req.params.id, req.user.id]);
  res.json({ ok: true });
});

app.post('/api/visits/:id/approve', auth(['manager','admin']), async (req,res)=>{
  await pool.query("UPDATE visits SET status='approved' WHERE id=?", [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/visits/:id/pdf', auth(['manager','admin','employee']), async (req,res)=>{
  const [visitRows] = await pool.query('SELECT v.*, b.name AS branch_name, b.location, c.name AS company_name FROM visits v JOIN branches b ON b.id=v.branch_id JOIN companies c ON c.id=b.company_id WHERE v.id=?', [req.params.id]);
  if (!visitRows[0]) return res.status(404).end();
  const [inv] = await pool.query('SELECT * FROM visit_inventory_items WHERE visit_id=?', [req.params.id]);
  const [cash] = await pool.query('SELECT * FROM visit_cash WHERE visit_id=?', [req.params.id]);
  const [notes] = await pool.query('SELECT * FROM visit_notes WHERE visit_id=? ORDER BY created_at');
  const pdfBuffer = await generateVisitPDFBuffer({ visit: visitRows[0], inventory: inv, cash: cash[0]||{}, notes });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="visit-'+req.params.id+'.pdf"');
  res.end(pdfBuffer);
});

app.post('/api/visits/:id/send', auth(['manager','admin']), async (req,res)=>{
  const [branchRows] = await pool.query('SELECT b.id FROM visits v JOIN branches b ON b.id=v.branch_id WHERE v.id=?', [req.params.id]);
  const branch = branchRows[0];
  if (!branch) return res.status(404).json({msg:'branch not found'});
  const [recipients] = await pool.query('SELECT * FROM branch_recipients WHERE branch_id=?', [branch.id]);

  const [visitRows] = await pool.query('SELECT v.*, b.name AS branch_name, b.location, c.name AS company_name FROM visits v JOIN branches b ON b.id=v.branch_id JOIN companies c ON c.id=b.company_id WHERE v.id=?', [req.params.id]);
  const [inv] = await pool.query('SELECT * FROM visit_inventory_items WHERE visit_id=?', [req.params.id]);
  const [cash] = await pool.query('SELECT * FROM visit_cash WHERE visit_id=?', [req.params.id]);
  const [notes] = await pool.query('SELECT * FROM visit_notes WHERE visit_id=? ORDER BY created_at');
  const pdfBuffer = await generateVisitPDFBuffer({ visit: visitRows[0], inventory: inv, cash: cash[0]||{}, notes });

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT||587),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  const toEmails = recipients.filter(r=>r.notify_email && r.email).map(r=>r.email);
  if (toEmails.length) {
    await transporter.sendMail({
      from: `ABROJ Reports <${process.env.SMTP_FROM}>`,
      to: toEmails,
      subject: `تقرير زيارة رقم ${req.params.id}`,
      text: 'مرفق تقرير الزيارة بصيغة PDF.',
      attachments: [{ filename: `visit-${req.params.id}.pdf`, content: pdfBuffer }]
    });
  }
  await pool.query("UPDATE visits SET status='sent' WHERE id=?", [req.params.id]);
  res.json({ ok: true, emails_sent: toEmails.length });
});

// Root
app.get('/', (req,res)=> res.send('ABROJ Field Inspection API Running'));

app.listen(process.env.PORT||3000, ()=> console.log('API ready'));
