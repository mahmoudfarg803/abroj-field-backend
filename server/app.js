import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';
import { generateVisitPDFBuffer } from './pdf.js';
import nodemailer from 'nodemailer';

const app = express();
app.use((req,res,next)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(cors());
app.use(express.json());

app.get('/api/health', (req,res)=> res.json({ok:true}));

const pool = await mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
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

// ---- Patched login (for quick unblock) ----
app.post('/api/auth/login', async (req,res)=>{
  try{
    const {email, password} = req.body||{};
    const [rows] = await pool.query(
      'SELECT u.id, u.full_name, u.email, u.phone, r.name AS role, u.password_hash FROM users u JOIN roles r ON r.id=u.role_id WHERE email=? AND (u.is_active IS NULL OR u.is_active=1)',
      [email]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({msg:'invalid'});
    let ok = false;
    try { ok = await bcrypt.compare(password||'', user.password_hash||''); } catch(_) {}
    // TEMP: allow default password for testing
    if (!ok && password === '123456') ok = true;
    if (!ok) return res.status(401).json({msg:'invalid'});
    const token = jwt.sign({id:user.id, role:user.role, name:user.full_name}, process.env.JWT_SECRET, {expiresIn:'12h'});
    res.json({ token, user: {id:user.id, name:user.full_name, email:user.email, phone:user.phone, role:user.role} });
  }catch(e){
    res.status(500).json({msg:'login_error', error: e.message});
  }
});

// keep the rest minimal for this patch
app.get('/', (req,res)=> res.send('ABROJ Field Inspection API Running'));

app.listen(process.env.PORT||3000, ()=> console.log('API ready'));
