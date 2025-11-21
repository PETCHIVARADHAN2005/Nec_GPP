// src/routes/test.routes.js
import express from 'express';
import {
  createTest,
  assignTest,
  uploadTestQuestionsBulk,
  addQuestionsToTest,
  getMyTests,
  startTest,
  submitTest
} from '../controllers/testController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();
router.use(protect);

router.post('/create', createTest);
router.post('/:testId/assign', assignTest);
router.post('/upload-bulk', uploadTestQuestionsBulk);
router.post('/:testId/add-questions', addQuestionsToTest);

router.get('/my-tests', getMyTests);
router.get('/:testId/start', startTest);
router.post('/:testId/submit', submitTest);

export default router;