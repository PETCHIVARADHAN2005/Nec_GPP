// src/controllers/topicController.js
import { pool } from '../config/db.js';
import { catchAsync } from '../utils/catchAsync.js';
import AppError from '../utils/AppError.js';

import {hasSubjectEditAccess} from './subjectController.js';
// Helper: Check if user has edit access to the subject
const checkSubjectEditAccess = async (subjectId, userId, role) => {
  if (role === 'Admin') return true;

  const [row] = await pool.execute(
    `SELECT 1 FROM subject_access_ids WHERE subject_id = ? AND user_id = ?`,
    [subjectId, userId]
  );
  if (row.length > 0) return true;

  if (role === 'Dept Head') {
    const [dept] = await pool.execute(`
      SELECT 1 FROM subject_access_dept sad
      JOIN staff st ON sad.dept_id = st.dept_id
      WHERE sad.subject_id = ? AND st.staff_id = ?
    `, [subjectId, userId]);
    return dept.length > 0;
  }
  return false;
};

// POST /api/v1/topics → Create new topic
export const createTopic = catchAsync(async (req, res, next) => {
  const { subject_id, topic_name } = req.body;
  const userId = req.user.useId;
  const role = req.user.role;

  if (!subject_id || !topic_name?.trim()) {
    return next(new AppError('subject_id and topic_name are required', 400));
  }

  const canEdit = await checkSubjectEditAccess(subject_id, userId, role);
  if (!canEdit) return next(new AppError('You do not have permission', 403));

  // Get next display_order
  const [order] = await pool.execute(
    `SELECT COALESCE(MAX(display_order), 0) + 1 as next_order FROM topics WHERE subject_id = ?`,
    [subject_id]
  );
  const displayOrder = order[0].next_order;

  const [result] = await pool.execute(
    `INSERT INTO topics (subject_id, topic_name, display_order, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?)`,
    [subject_id, topic_name.trim(), displayOrder, userId, userId]
  );

  res.status(201).json({
    status: 'success',
    data: {
      topic_id: result.insertId,
      topic_name: topic_name.trim(),
      display_order: displayOrder
    }
  });
});

// PATCH /api/v1/topics/:topicId/name
export const updateTopicName = catchAsync(async (req, res, next) => {
  const { topicId } = req.params;
  const { topic_name } = req.body;
  const userId = req.user.userId;
  const role = req.user.role;

  if (!topic_name?.trim()) return next(new AppError('Topic name required', 400));

  const [topics] = await pool.execute(`SELECT subject_id FROM topics WHERE topic_id = ?`, [topicId]);
  if (topics.length === 0) return next(new AppError('Topic not found', 404));

  const canEdit = await checkSubjectEditAccess(topics[0].subject_id, userId, role);
  if (!canEdit) return next(new AppError('Permission denied', 403));

  await pool.execute(
    `UPDATE topics SET topic_name = ?, updated_by = ? WHERE topic_id = ?`,
    [topic_name.trim(), userId, topicId]
  );

  res.status(200).json({ status: 'success', message: 'Topic renamed' });
});

// PATCH /api/v1/topics/reorder → Drag & Drop Reorder
export const reorderTopics = catchAsync(async (req, res, next) => {
  const { subject_id, ordered_topic_ids } = req.body; // array of topic_id in new order
  const userId = req.user.userId;
  const role = req.user.role;

  if (!Array.isArray(ordered_topic_ids) || ordered_topic_ids.length === 0) {
    return next(new AppError('ordered_topic_ids array required', 400));
  }

  const canEdit = await checkSubjectEditAccess(subject_id, userId, role);
  if (!canEdit) return next(new AppError('Permission denied', 403));

  const conn = await pool.getConnection();
  await conn.beginTransaction();

  try {
    const placeholders = ordered_topic_ids.map(() => '(?, ?, ?)').join(', ');
    const values = [];
    ordered_topic_ids.forEach((topicId, index) => {
      values.push(subject_id, topicId, index + 1);
    });

    await conn.execute(
      `INSERT INTO topics (subject_id, topic_id, display_order) 
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE display_order = VALUES(display_order)`,
      values
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  res.status(200).json({ status: 'success', message: 'Topics reordered successfully' });
});




// Helper: Check edit access for topic (same as subject)
const hasTopicEditAccess = async (topicId, userId, role) => {
  const [subject] = await pool.execute('SELECT subject_id FROM topics WHERE topic_id = ?', [topicId]);
  if (!subject[0]) return false;
  return await hasSubjectEditAccess(subject[0].subject_id, userId, role);
};

// 1. GET /api/v1/topics/:topicId → Main View (Student + Staff)
export const getTopicWithLevels = catchAsync(async (req, res, next) => {
  const { topicId } = req.params;
  const userId = req.user.userId;
  const role = req.user.role;

  const [topic] = await pool.execute(
    'SELECT topic_id, topic_name, subject_id FROM topics WHERE topic_id = ?', [topicId]
  );
  if (!topic[0]) return next(new AppError('Topic not found', 404));

  const subjectId = topic[0].subject_id;
  const canEdit = await hasSubjectEditAccess(subjectId, userId, role);
  const canRecord = role === 'Student' ? await studentHasRecordAccess(subjectId, userId) : false;

  const [levels] = await pool.execute(`
    SELECT l.level_id, l.level_name, l.display_order, l.threshold_percentage, l.total_marks
    FROM levels l
    WHERE l.topic_id = ?
    ORDER BY l.display_order ASC
  `, [topicId]);

  // For Students: Determine which levels are unlocked
  let unlockedUpTo = 0;
  if (role === 'Student') {
    for (let i = 0; i < levels.length; i++) {
      const passed = await hasPassedLevel(userId, levels[i].level_id);
      if (passed || i === 0) unlockedUpTo = i + 1;
      else break;
    }
  }

  res.status(200).json({
    status: 'success',
    data: {
      topic: topic[0],
      canEdit,
      canRecord,
      canManageCollaborators: canEdit,
      levels: levels.map((l, idx) => ({
        ...l,
        isUnlocked: role !== 'Student' || idx < unlockedUpTo,
        isFirst: idx === 0,
        requiresPrevious: idx > 0
      }))
    }
  });
});



// 3. REORDER LEVELS (Drag & Drop)
// Helper: Has student passed a level?
const hasPassedLevel = async (studentId, levelId) => {
  const [attempt] = await pool.execute(`
    SELECT score_percentage FROM student_level_attempts
    WHERE student_id = ? AND level_id = ? AND score_percentage >= (
      SELECT threshold_percentage FROM levels WHERE level_id = ?
    ) ORDER BY attempted_at DESC LIMIT 1
  `, [studentId, levelId, levelId]);
  return attempt.length > 0;
};

// Helper: Does student have record access to subject?
const studentHasRecordAccess = async (subjectId, studentId) => {
  const [row] = await pool.execute(`
    SELECT 1 FROM students s
    JOIN subject_access_dept sad ON s.dept_id = sad.dept_id
    WHERE s.student_id = ? AND sad.subject_id = ?
  `, [studentId, subjectId]);
  return row.length > 0;
};

