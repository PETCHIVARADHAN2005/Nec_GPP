// src/middleware/auth.js
import { verifyAccessToken } from '../utils/jwt.js';
import  AppError  from '../utils/AppError.js';
import { catchAsync } from '../utils/catchAsync.js';

export const protect = catchAsync(async (req, res, next) => {
  const token = req.cookies.access_token;
  if (!token) return next(new AppError('Please log in to access', 401));

  const decoded = verifyAccessToken(token);
  req.user = decoded;
  next();
});

export const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return next(new AppError('Access denied', 403));
    }
    next();
  };
};