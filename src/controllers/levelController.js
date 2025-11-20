export const reorderLevels = catchAsync(async (req, res, next) => {
  const { topicId } = req.params;
  const { orderedLevelIds } = req.body; // [3,1,4,2]

  if (!await hasTopicEditAccess(topicId, req.user.userId, req.user.role))
    return next(new AppError('No permission', 403));

  const conn = await pool.getConnection();
  await conn.beginTransaction();

  try {
    for (let i = 0; i < orderedLevelIds.length; i++) {
      await conn.execute(
        'UPDATE levels SET display_order = ? WHERE level_id = ? AND topic_id = ?',
        [i + 1, orderedLevelIds[i], topicId]
      );
    }
    await conn.commit();
    res.status(200).json({ status: 'success', message: 'Order updated' });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});


// POST /api/v1/topics/:topicId/levels/complete
export const createLevelWithQuestions = catchAsync(async (req, res, next) => {
  const { topicId } = req.params;
  const { level_name, threshold_percentage = 60, questions = [] } = req.body;
  const userId = req.user.userId;
  const role = req.user.role;

  if (!level_name || level_name.trim().length < 2) {
    return next(new AppError('Level name is required', 400));
  }

  // Check edit access
  const [topic] = await pool.execute('SELECT subject_id FROM topics WHERE topic_id = ?', [topicId]);
  if (!topic[0]) return next(new AppError('Topic not found', 404));
  const canEdit = await hasSubjectEditAccess(topic[0].subject_id, userId, role);
  if (!canEdit) return next(new AppError('You do not have permission to create levels', 403));

  const conn = await pool.getConnection();
  await conn.beginTransaction();

  try {
    // 1. Create Level
    const [levelResult] = await conn.execute(
      `INSERT INTO levels 
       (topic_id, level_name, threshold_percentage, display_order, created_by, updated_by)
       VALUES (?, ?, ?, 
         (SELECT IFNULL(MAX(display_order), 0) + 1 FROM levels l WHERE l.topic_id = ?), 
         ?, ?)`,
      [topicId, level_name.trim(), threshold_percentage, topicId, userId, userId]
    );
    const levelId = levelResult.insertId;

    // 2. Insert Questions (if any)
    if (questions.length > 0) {
      const questionValues = [];
      const levelQuestionLinks = [];

      for (const q of questions) {
        const {
          question_type,
          question_text,
          option_a, option_b, option_c, option_d,
          correct_answer,
          marks = question_type === 'NAT' ? 1 : 2,
          image_url = null,
          purpose = 'Both' // or 'Practice', 'Test'
        } = q;

        if (!question_text || !correct_answer) {
          throw new AppError('Each question must have text and correct answer', 400);
        }

        questionValues.push([
          question_type,
          0, // practice_order_no
          purpose,
          question_text,
          option_a || null,
          option_b || null,
          option_c || null,
          option_d || null,
          correct_answer,
          marks,
          image_url,
          userId,
          userId
        ]);

        // We'll get question_id after bulk insert
      }

      if (questionValues.length > 0) {
        // Bulk insert questions
        const [qResult] = await conn.query(
          `INSERT INTO questions 
           (question_type, question_practice_order_no, purpose, question_text, 
            option_a, option_b, option_c, option_d, correct_answer, marks, image_url, 
            created_by, updated_by)
           VALUES ?`,
          [questionValues]
        );

        const firstQuestionId = qResult.insertId;
        for (let i = 0; i < questionValues.length; i++) {
          levelQuestionLinks.push([levelId, firstQuestionId + i]);
        }

        // Link questions to level
        await conn.query(
          `INSERT INTO level_questions (level_id, question_id) VALUES ?`,
          [levelQuestionLinks]
        );
      }
    }

    await conn.commit();

    res.status(201).json({
      status: 'success',
      message: 'Level and questions created successfully',
      data: {
        level_id: levelId,
        level_name,
        questions_count: questions.length
      }
    });

  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_PARSE_ERROR') {
      return next(new AppError('Invalid question data format', 400));
    }
    next(err);
  } finally {
    conn.release();
  }
});

// POST /api/v1/topics/parse-bulk-questions
import multer from 'multer';
import xlsx from 'xlsx';

const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

export const parseBulkQuestions = catchAsync(async (req, res, next) => {
  if (!req.file) return next(new AppError('No file uploaded', 400));

  const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet);

  const parsedQuestions = rows.map(row => ({
    question_type: row.TYPE?.toUpperCase() || 'MCQ',
    question_text: row.QUESTION || row.QUESTION_TEXT,
    option_a: row.A,
    option_b: row.B,
    option_c: row.C,
    option_d: row.D,
    correct_answer: row.CORRECT_ANSWER || row.ANSWER,
    marks: row.MARKS || (row.TYPE === 'NAT' ? 1 : 2),
    image_url: row.IMAGE_URL || null
  }));

  res.status(200).json({
    status: 'success',
    data: { questions: parsedQuestions }
  });
});