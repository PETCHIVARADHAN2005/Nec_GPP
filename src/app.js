// src/app.js
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import { globalErrorHandler } from './middleware/errorHandler.js';

import authRoutes from './routes/auth.routes.js';
import userRoutes from './routes/user.routes.js';
import subjectRoutes from './routes/subject.routes.js';


const app = express();

// Security middleware
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));

// Rate limiting
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Routes
app.get('/', (req, res) => res.json({ message: 'NEC GATE Portal API v1.0' }));

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/subjects', subjectRoutes);

// 404
app.all('*', (req, res, next) => {
  next(new AppError(`Route ${req.originalUrl} not found`, 404));
});

app.use(globalErrorHandler);

export default app;