// src/config/database.js
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

export const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 15,
  queueLimit: 0,
  timezone: '+05:30',
  decimalNumbers: true
});

pool.getConnection()
  .then(() => console.log('MySQL Connected Successfully'))
  .catch(err => console.error('DB Connection Failed:', err.message));