// src/routes/subject.routes.js
import express from 'express';
import { protect } from '../middleware/auth.js';

const router = express.Router();



// All subject routes require login
router.use(protect);

route

export default router;