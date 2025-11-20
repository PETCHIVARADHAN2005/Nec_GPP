// src/routes/subject.routes.js
import express from 'express';
import { protect } from '../middleware/auth.js';
import { getMySubjects,createSubject,getTopicsBySubId,getSubjectMembers,addSubjectMember,removeSubjectMember,leaveSubject } from '../controllers/subjectController.js';

const router = express.Router();

// All subject routes require login
router.use(protect);

router.get('/get-subjects', getMySubjects);
router.post('/create-subject', createSubject);
router.get('/:subjectId', getTopicsBySubId);
router.get('/:subjectId/members', getSubjectMembers);         // In-Access & Out-Access UI
router.post('/:subjectId/add-members', addSubjectMember);         // Add Staff / Dept Head
router.delete('/:subjectId/members/:targetId', removeSubjectMember); // Remove member
router.post('/:subjectId/leave', leaveSubject);
router.post('/', createSubject);
export default router;