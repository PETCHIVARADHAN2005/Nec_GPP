// src/controllers/testController.js
import { pool } from '../config/database.js';
import { catchAsync } from '../utils/catchAsync.js';
import AppError from '../utils/AppError.js';
import multer from 'multer';
import xlsx from 'xlsx';

const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

// ====================== CREATE TEST ======================
export const createTest = catchAsync(async (req, res, next) => {
  const { test_name, duration_minutes, start_time, end_time } = req.body;
  const creatorId = req.user.userId;

  if (!['Admin', 'Dept Head', 'Staff'].includes(req.user.role)) {
    return next(new AppError('Unauthorized to create test', 403));
  }

  if (!test_name || !duration_minutes || !start_time || !end_time) {
    return next(new AppError('All fields required', 400));
  }

  const [result] = await pool.execute(
    `INSERT INTO tests (test_name, duration_minutes, start_time, end_time, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    [test_name, duration_minutes, start_time, end_time, creatorId]
  );

  res.status(201).json({
    status: 'success',
    data: { test_id: result.insertId, test_name }
  });
});

// ====================== ASSIGN TEST ======================
export const assignTest = catchAsync(async (req, res, next) => {
  const { testId } = req.params;
  const { dept_ids = [], batch_years = [] } = req.body;

  if (!['Admin', 'Dept Head', 'Staff'].includes(req.user.role)) {
    return next(new AppError('Unauthorized', 403));
  }

  const conn = await pool.getConnection();
  await conn.beginTransaction();

  try {
    await conn.execute(`DELETE FROM test_dept_assignment WHERE test_id = ?`, [testId]);
    await conn.execute(`DELETE FROM test_year_assignment WHERE test_id = ?`, [testId]);

    if (dept_ids.length > 0) {
      const values = dept_ids.map(id => [testId, id]);
      await conn.query(`INSERT INTO test_dept_assignment (test_id, dept_id) VALUES ?`, [values]);
    }

    if (batch_years.length > 0) {
      const values = batch_years.map(year => [testId, year]);
      await conn.query(`INSERT INTO test_year_assignment (test_id, batch_year) VALUES ?`, [values]);
    }

    await conn.commit();
    res.status(200).json({ status: 'success', message: 'Test assigned' });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// ====================== BULK UPLOAD (EXCEL) ======================
export const uploadTestQuestionsBulk = [
  upload.single('file'),
  catchAsync(async (req, res, next) => {
    if (!req.file) return next(new AppError('No file uploaded', 400));

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet);

    const questions = rows.map(row => ({
      question_type: (row.TYPE || row.question_type || 'MCQ').toUpperCase(),
      question_text: row.QUESTION || row.question_text,
      option_a: row.A || row.option_a,
      option_b: row.B || row.option_b,
      option_c: row.C || row.option_c,
      option_d: row.D || row.option_d,
      correct_answer: row.CORRECT_ANSWER || row.correct_answer || row.ANSWER,
      image_url: row.IMAGE_URL || row.image_url || null
    }));

    res.status(200).json({ status: 'success', data: { questions } });
  })
];

// ====================== ADD QUESTIONS TO TEST (Manual + Bulk) ======================
export const addQuestionsToTest = catchAsync(async (req, res, next) => {
  const { testId } = req.params;
  const { questions = [] } = req.body;
  const userId = req.user.userId;

  if (questions.length === 0) return next(new AppError('No questions', 400));

  const conn = await pool.getConnection();
  await conn.beginTransaction();

  try {
    const qValues = [];
    const linkValues = [];

    for (const q of questions) {
      const {
        question_type, question_text, option_a, option_b, option_c, option_d,
        correct_answer, image_url = null
      } = q;

      qValues.push([
        question_type, question_text,
        option_a || null, option_b || null, option_c || null, option_d || null,
        correct_answer, 2, image_url, userId, userId
      ]);
    }

    const [res] = await conn.query(
      `INSERT INTO questions 
       (question_type, question_text, option_a, option_b, option_c, option_d,
        correct_answer, marks, image_url, created_by, updated_by)
       VALUES ?`,
      [qValues]
    );

    const firstId = res.insertId;
    for (let i = 0; i < questions.length; i++) {
      linkValues.push([testId, firstId + i]);
    }

    await conn.query(`INSERT INTO test_questions (test_id, question_id) VALUES ?`, [linkValues]);

    await conn.commit();
    res.status(201).json({ status: 'success', message: `${questions.length} questions added` });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// ====================== GET MY TESTS (Student) ======================
export const getMyTests = catchAsync(async (req, res, next) => {
  const studentId = req.user.userId;

  const [student] = await pool.execute(`SELECT dept_id, batch_year FROM students WHERE student_id = ?`, [studentId]);
  if (!student[0]) return next(new AppError('Student not found', 404));

  const { dept_id, batch_year } = student[0];

  const [tests] = await pool.query(`
    SELECT DISTINCT t.*, COALESCE(sta.score, -1) as score, sta.submitted_at
    FROM tests t
    LEFT JOIN test_dept_assignment tda ON t.test_id = tda.test_id
    LEFT JOIN test_year_assignment tya ON t.test_id = tya.test_id
    LEFT JOIN student_test_attempts sta ON t.test_id = sta.test_id AND sta.student_id = ?
    WHERE (tda.dept_id IS NULL OR tda.dept_id = ?) 
      AND (tya.batch_year IS NULL OR tya.batch_year = ?)
    ORDER BY t.start_time DESC
  `, [studentId, dept_id, batch_year]);

  const now = new Date();
  const upcoming = [], live = [], past = [];

  tests.forEach(t => {
    const start = new Date(t.start_time);
    const end = new Date(t.end_time);
    const item = { ...t, attended: t.score !== -1 };

    if (now < start) upcoming.push(item);
    else if (now >= start && now < end) live.push(item);
    else past.push(item);
  });

  res.status(200).json({ status: 'success', data: { upcoming, live, past } });
});

// ====================== START TEST ======================
export const startTest = catchAsync(async (req, res, next) => {
  const { testId } = req.params;
  const studentId = req.user.userId;

  const [attempt] = await pool.execute(`SELECT 1 FROM student_test_attempts WHERE test_id = ? AND student_id = ?`, [testId, studentId]);
  if (attempt.length > 0) return next(new AppError('Already attempted', 400));

  const [test] = await pool.execute(`SELECT * FROM tests WHERE test_id = ?`, [testId]);
  const now = new Date();
  if (now < new Date(test[0].start_time)) return next(new AppError('Test not started', 400));
  if (now > new Date(test[0].end_time)) return next(new AppError('Test expired', 400));

  await pool.execute(`INSERT INTO student_test_attempts (test_id, student_id, started_at) VALUES (?, ?, NOW())`, [testId, studentId]);

  const [questions] = await pool.query(`
    SELECT q.* FROM questions q
    JOIN test_questions tq ON q.question_id = tq.question_id
    WHERE tq.test_id = ?
    ORDER BY RAND()
  `, [testId]);

  res.status(200).json({ status: 'success', data: { test: test[0], questions } });
});

// ====================== SUBMIT TEST (YOUR 100-MARK SYSTEM) ======================
export const submitTest = catchAsync(async (req, res, next) => {
  const { testId } = req.params;
  const { responses } = req.body;
  const studentId = req.user.userId;

  const conn = await pool.getConnection();
  await conn.beginTransaction();

  try {
    const [totalQ] = await conn.execute(`SELECT COUNT(*) as total FROM test_questions WHERE test_id = ?`, [testId]);
    const totalQuestions = totalQ[0].total;
    if (totalQuestions === 0) return next(new AppError('No questions', 400));

    let correct = 0;

    for (const r of responses) {
      const { question_id, selected_options = [], nat_answer } = r;
      const [q] = await conn.execute(`SELECT * FROM questions WHERE question_id = ?`, [question_id]);
      if (!q[0]) continue;

      let isCorrect = false;
      if (q[0].question_type === 'MCQ') {
        isCorrect = selected_options[0]?.trim() === q[0].correct_answer.trim();
      } else if (q[0].question_type === 'MSQ') {
        const correct = JSON.parse(q[0].correct_answer).map(a => a.trim()).sort();
        const selected = selected_options.map(a => a.trim()).sort();
        isCorrect = JSON.stringify(selected) === JSON.stringify(correct);
      } else if (q[0].question_type === 'NAT') {
        isCorrect = parseFloat(nat_answer) === parseFloat(q[0].correct_answer);
      }

      if (isCorrect) correct++;

      await conn.execute(
        `INSERT INTO student_test_responses (test_id, student_id, question_id, selected_options, nat_answer, is_correct)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [testId, studentId, question_id, JSON.stringify(selected_options), nat_answer || null, isCorrect ? 1 : 0]
      );
    }

    const score = Math.round((correct / totalQuestions) * 100 * 100) / 100;

    await conn.execute(
      `UPDATE student_test_attempts SET score = ?, submitted_at = NOW() WHERE test_id = ? AND student_id = ?`,
      [score, testId, studentId]
    );

    await conn.execute(`UPDATE students SET test_score = test_score + ? WHERE student_id = ?`, [score, studentId]);

    await conn.commit();

    res.status(200).json({
      status: 'success',
      data: { score, correct, total: totalQuestions, percentage: `${score}%` }
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});