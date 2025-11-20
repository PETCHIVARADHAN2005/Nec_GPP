// src/routes/user.routes.js
import express from 'express';
import { protect } from '../middleware/auth.js';
import { getMyDashboard, getMyProfile } from '../controllers/userController.js';

const router = express.Router();

// All routes below require authentication
router.use(protect);

router.get('/me', getMyDashboard);
router.get('/me/profile', getMyProfile);

export default router;