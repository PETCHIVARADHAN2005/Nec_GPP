// src/controllers/authController.js
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { pool } from '../config/database.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken
} from '../utils/jwt.js';
import { sendOTPEmail } from '../utils/sendEmail.js';
import { catchAsync } from '../utils/catchAsync.js';
import  AppError  from '../utils/AppError.js';

const setCookie = (res, name, value, days) => {
  res.cookie(name, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: days * 24 * 60 * 60 * 1000
  });
};

export const login = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;

  const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
  const user = rows[0];

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return next(new AppError('Invalid email or password', 401));
  }

  const accessToken = signAccessToken({ userId: user.user_id, role: user.role });
  const refreshToken = signRefreshToken({ userId: user.user_id });
  const tokenHash = await bcrypt.hash(refreshToken, 10);

  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY))`,
    [user.user_id, tokenHash]
  );

  setCookie(res, 'access_token', accessToken, 1);
  setCookie(res, 'refresh_token', refreshToken, 30);

  await pool.query('UPDATE users SET last_login = NOW() WHERE user_id = ?', [user.user_id]);

  res.json({
    success: true,
    user: {
      id: user.user_id,
      name: user.full_name,
      email: user.email,
      role: user.role
    }
  });
});

export const refreshToken = catchAsync(async (req, res, next) => {
  const oldToken = req.cookies.refresh_token;
  if (!oldToken) return next(new AppError('No token', 401));

  const { userId } = verifyRefreshToken(oldToken);

  const [tokens] = await pool.query(
    'SELECT * FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL AND expires_at > NOW()',
    [userId]
  );

  if (tokens.length === 0 || !(await bcrypt.compare(oldToken, tokens[0].token_hash))) {
    return next(new AppError('Invalid refresh token', 401));
  }

  await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = ?', [tokens[0].id]);

  const [users] = await pool.query('SELECT * FROM users WHERE user_id = ?', [userId]);
  const user = users[0];

  const newAccess = signAccessToken({ userId: user.user_id, role: user.role });
  const newRefresh = signRefreshToken({ userId: user.user_id });
  const newHash = await bcrypt.hash(newRefresh, 10);

  await pool.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY))',
    [userId, newHash]
  );

  setCookie(res, 'access_token', newAccess, 1);
  setCookie(res, 'refresh_token', newRefresh, 30);

  res.json({ success: true });
});

export const logout = catchAsync(async (req, res) => {
  const token = req.cookies.refresh_token;
  if (token) {
    try {
      const { userId } = verifyRefreshToken(token);
      await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ?', [userId]);
    } catch (e) {}
  }
  res.clearCookie('access_token');
  res.clearCookie('refresh_token');
  res.json({ success: true, message: 'Logged out' });
});

export const forgotPassword = catchAsync(async (req, res, next) => {
  const { email } = req.body;
  const [users] = await pool.query('SELECT user_id, full_name FROM users WHERE email = ?', [email]);
  const user = users[0];

  if (!user) return res.json({ success: true, message: 'If email exists, OTP sent' });

  const oneHourAgo = new Date(Date.now() - 3600000);
  const [count] = await pool.query(
    'SELECT COUNT(*) as c FROM password_reset_otps WHERE user_id = ? AND created_at > ?',
    [user.user_id, oneHourAgo]
  );
  if (count[0].c >= 3) return next(new AppError('Too many requests', 429));

  const otp = crypto.randomInt(100000, 999999).toString();
  const otpHash = await bcrypt.hash(otp, 12);

  await pool.query(
    'INSERT INTO password_reset_otps (user_id, otp_code, otp_hash, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))',
    [user.user_id, otp, otpHash]
  );

  await sendOTPEmail(email, user.full_name, otp);
  res.json({ success: true, message: 'OTP sent' });
});

export const verifyOTP = catchAsync(async (req, res, next) => {
  const { email, otp } = req.body;
  const [users] = await pool.query('SELECT user_id FROM users WHERE email = ?', [email]);
  if (!users[0]) return next(new AppError('Invalid', 400));

  const [otps] = await pool.query(
    'SELECT * FROM password_reset_otps WHERE user_id = ? AND used_at IS NULL AND expires_at > NOW() ORDER BY id DESC LIMIT 1',
    [users[0].user_id]
  );

  if (!otps[0] || !(await bcrypt.compare(otp, otps[0].otp_hash))) {
    return next(new AppError('Invalid or expired OTP', 400));
  }

  await pool.query('UPDATE password_reset_otps SET used_at = NOW() WHERE id = ?', [otps[0].id]);
  res.json({ success: true, userId: users[0].user_id });
});

export const resetPassword = catchAsync(async (req, res, next) => {
  const { userId, newPassword, confirmPassword } = req.body;
  if (newPassword !== confirmPassword) return next(new AppError('Passwords do not match', 400));

  const hash = await bcrypt.hash(newPassword, 12);
  await pool.query('UPDATE users SET password_hash = ? WHERE user_id = ?', [hash, userId]);
  await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ?', [userId]);

  res.json({ success: true, message: 'Password reset successful' });
});

export const changePassword = catchAsync(async (req, res, next) => {
  const { currentPassword, newPassword } = req.body;
  const userId = req.user.userId;

  const [rows] = await pool.query('SELECT password_hash FROM users WHERE user_id = ?', [userId]);
  if (!(await bcrypt.compare(currentPassword, rows[0].password_hash))) {
    return next(new AppError('Current password wrong', 401));
  }

  const hash = await bcrypt.hash(newPassword, 12);
  await pool.query('UPDATE users SET password_hash = ? WHERE user_id = ?', [hash, userId]);
  await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ?', [userId]);

  res.clearCookie('access_token');
  res.clearCookie('refresh_token');
  res.json({ success: true, message: 'Password changed. Logged out from all devices.' });
});