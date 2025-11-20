// src/routes/auth.routes.js
import express from 'express';
import {
  login,
  logout,
  refreshToken,
  forgotPassword,
  verifyOTP,
  resetPassword,
  changePassword
} from '../controllers/authController.js';
import { protect } from '../middleware/auth.js';
import { loginLimiter, otpLimiter } from '../middleware/rateLimiter.js';

const router = express.Router();

router.post('/login', loginLimiter, login);
router.post('/refresh-token', refreshToken);
router.post('/logout', protect, logout);
router.post('/change-password', protect, changePassword);

router.post('/forgot-password', otpLimiter, forgotPassword);
router.post('/verify-otp', verifyOTP);
router.post('/reset-password', resetPassword);

export default router;