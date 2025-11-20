// src/controllers/subjectController.js
import { pool } from '../config/db.js';
import { catchAsync } from '../utils/catchAsync.js';
import AppError from '../utils/AppError.js';

export const getMySubjects = catchAsync(async (req, res, next) => {
  const user = req.user; // from protect middleware
  const userId = user.userId;
  const role = user.role;

  let mySubjects = [];
  let otherSubjects = [];

  // COMMON: Get all subjects base
  const [allSubjects] = await pool.execute(`
    SELECT subject_id, subject_name, created_at 
    FROM subjects 
    ORDER BY subject_name
  `);

  if (role === 'Admin') {
    // Admin sees ALL subjects as "My Subjects" with full edit rights
    mySubjects = allSubjects.map(s => ({
      ...s,
      canEdit: true,
      canRecord: false
    }));
  } 
  else if (role === 'Student') {
    // Get student's dept_id
    const [studentRows] = await pool.execute(
      'SELECT dept_id FROM students WHERE student_id = ?',
      [userId]
    );

    if (studentRows.length === 0) {
      return res.status(200).json({ status: 'success', data: { mySubjects: [], otherSubjects: [] } });
    }

    const deptId = studentRows[0].dept_id;
    if (!deptId) {
      // No dept assigned → no access
      otherSubjects = allSubjects.map(s => ({
        ...s,
        canEdit: false,
        canRecord: false
      }));
    } else {
      // Get subjects assigned to student's dept
      const [accessible] = await pool.execute(`
        SELECT s.subject_id, s.subject_name, s.created_at
        FROM subjects s
        JOIN subject_access_dept sad ON s.subject_id = sad.subject_id
        WHERE sad.dept_id = ?
      `, [deptId]);

      const accessibleIds = accessible.map(x => x.subject_id);

      // All dept-accessible → canRecord: true, canEdit: false
      accessible.forEach(sub => {
        mySubjects.push({
          ...sub,
          canEdit: false,
          canRecord: true   // Only place where canRecord = true
        });
      });

      // Remaining subjects → view only, no record
      allSubjects.forEach(sub => {
        if (!accessibleIds.includes(sub.subject_id)) {
          otherSubjects.push({
            ...sub,
            canEdit: false,
            canRecord: false
          });
        }
      });
    }
  } 
  else if (role === 'Staff' || role === 'Dept Head') {
    let mySubjectIds = [];

    if (role === 'Staff') {
      // Staff: direct access via subject_access_ids
      const [access] = await pool.execute(`
        SELECT subject_id FROM subject_access_ids WHERE user_id = ?
      `, [userId]);
      mySubjectIds = access.map(x => x.subject_id);
    } 
    else if (role === 'Dept Head') {
      // Dept Head: via dept access
      const [deptRows] = await pool.execute(`
        SELECT dept_id FROM staff WHERE staff_id = ?
      `, [userId]);

      if (deptRows.length > 0 && deptRows[0].dept_id) {
        const [access] = await pool.execute(`
          SELECT subject_id FROM subject_access_dept WHERE dept_id = ?
        `, [deptRows[0].dept_id]);
        mySubjectIds = access.map(x => x.subject_id);
      }
    }

    // Classify
    allSubjects.forEach(sub => {
      if (mySubjectIds.includes(sub.subject_id)) {
        mySubjects.push({
          ...sub,
          canEdit: true,
          canRecord: false
        });
      } else {
        otherSubjects.push({
          ...sub,
          canEdit: false,
          canRecord: false
        });
      }
    });
  }

  res.status(200).json({
    status: 'success',
    data: {
      mySubjects,
      otherSubjects
    }
  });
});


export const createSubject = catchAsync(async (req, res, next) => {
  const { subject_name } = req.body;
  const creatorId = req.user.userId;
  const role = req.user.role;

  if (!subject_name || subject_name.trim().length < 3) {
    return next(new AppError('Subject name must be at least 3 characters', 400));
  }

  // Start transaction
  const conn = await pool.getConnection();
  await conn.beginTransaction();

  try {
    // 1. Insert subject
    const [result] = await conn.execute(
      `INSERT INTO subjects (subject_name, created_by, updated_by) VALUES (?, ?, ?)`,
      [subject_name.trim(), creatorId, creatorId]
    );
    const subjectId = result.insertId;

    // 2. Get all Admin IDs
    const [admins] = await conn.execute(`SELECT user_id FROM users WHERE role = 'Admin'`);

    // 3. Always give access to all Admins
    if (admins.length > 0) {
      const adminValues = admins.map(a => [subjectId, a.user_id, 'Admin']);
      await conn.query(
        `INSERT IGNORE INTO subject_access_ids (subject_id, user_id, access_role) VALUES ?`,
        [adminValues]
      );
    }

    // 4. Role-specific logic
    if (role === 'Dept Head' || role === 'Staff') {
      // Get creator's dept_id
      const [staffRow] = await conn.execute(
        `SELECT dept_id FROM staff WHERE staff_id = ?`,
        [creatorId]
      );
      const deptId = staffRow[0]?.dept_id;

      if (!deptId) throw new AppError('Department not found for user', 400);

      // Add dept to subject_access_dept
      await conn.execute(
        `INSERT IGNORE INTO subject_access_dept (subject_id, dept_id) VALUES (?, ?)`,
        [subjectId, deptId]
      );

      // Find Dept Head
      const [dept] = await conn.execute(
        `SELECT head_user_id FROM departments WHERE dept_id = ?`,
        [deptId]
      );
      const headId = dept[0]?.head_user_id;

      if (role === 'Dept Head') {
        // Dept Head creates → add himself
        await conn.execute(
          `INSERT IGNORE INTO subject_access_ids (subject_id, user_id, access_role) VALUES (?, ?, 'DeptHead')`,
          [subjectId, creatorId]
        );
      } else if (role === 'Staff') {
        // Staff creates → add himself + Dept Head
        await conn.execute(
          `INSERT IGNORE INTO subject_access_ids (subject_id, user_id, access_role) VALUES (?, ?, 'StaffHandler')`,
          [subjectId, creatorId]
        );
        if (headId) {
          await conn.execute(
            `INSERT IGNORE INTO subject_access_ids (subject_id, user_id, access_role) VALUES (?, ?, 'DeptHead')`,
            [subjectId, headId]
          );
        }
      }
    }

    await conn.commit();

    res.status(201).json({
      status: 'success',
      data: {
        subject_id: subjectId,
        subject_name: subject_name.trim(),
        message: 'Subject created successfully with access rules applied'
      }
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// GET /api/v1/subjects/:subjectId
export const getTopicsBySubId = catchAsync(async (req, res, next) => {
  const { subjectId } = req.params;
  const userId = req.user.userId;
  const role = req.user.role;
/*
  // 1. Get subject
  const [subjects] = await pool.execute(
    `SELECT subject_id, subject_name, created_at FROM subjects WHERE subject_id = ?`,
    [subjectId]
  );
  if (subjects.length === 0) return next(new AppError('Subject not found', 404));
  const subject = subjects[0];

  // 2. Determine permissions
  let canEdit = false;
  let canRecord = false;

  if (role === 'Admin') {
    canEdit = true;
  } else if (role === 'Student') {
    const [row] = await pool.execute(
      `SELECT 1 FROM students s 
       JOIN subject_access_dept sad ON s.dept_id = sad.dept_id 
       WHERE s.student_id = ? AND sad.subject_id = ?`,
      [userId, subjectId]
    );
    canRecord = row.length > 0;
  } else if (role === 'Staff' || role === 'Dept Head') {
    const [row] = await pool.execute(
      `SELECT 1 FROM subject_access_ids WHERE subject_id = ? AND user_id = ?`,
      [subjectId, userId]
    );
    canEdit = row.length > 0;

    if (role === 'Dept Head') {
      const [deptRow] = await pool.execute(
        `SELECT 1 FROM subject_access_dept sad 
         JOIN staff st ON sad.dept_id = st.dept_id 
         WHERE sad.subject_id = ? AND st.staff_id = ?`,
        [subjectId, userId]
      );
      canEdit = canEdit || deptRow.length > 0;
    }
  }

  // 3. Get topics ordered
  const [topics] = await pool.execute(
    `SELECT topic_id, topic_name, display_order 
     FROM topics 
     WHERE subject_id = ? 
     ORDER BY display_order ASC, topic_id ASC`,
    [subjectId]
  );

  res.status(200).json({
    status: 'success',
    data: {
      subject,
      permissions: { canEdit, canRecord },
      topics: topics.map((t, idx) => ({
        ...t,
        display_order: t.display_order || idx + 1
      }))
    }
  });
});
*/
  // 3. Get topics ordered
  const [topics] = await pool.execute(
    `SELECT topic_id, topic_name, display_order 
     FROM topics 
     WHERE subject_id = ? 
     ORDER BY display_order ASC, topic_id ASC`,
    [subjectId]
  );

  res.status(200).json({
    status: 'success',
    data: {
      subjectId,
      topics: topics.map((t, idx) => ({
        ...t,
        display_order: t.display_order || idx + 1
      }))
    }
  });
});
const hasSubjectEditAccess = async (subjectId, userId, role) => {
  if (role === 'Admin') return true;

  const [direct] = await pool.execute(
    'SELECT 1 FROM subject_access_ids WHERE subject_id = ? AND user_id = ?',
    [subjectId, userId]
  );
  if (direct.length > 0) return true;

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
// GET /api/v1/subjects/:subjectId/members → In-Access & Out-Access Lists
export const getSubjectMembers = catchAsync(async (req, res, next) => {
  const { subjectId } = req.params;
  const userId = req.user.userId;
  const role = req.user.role;

  // Verify subject exists
  const [subject] = await pool.execute('SELECT subject_name FROM subjects WHERE subject_id = ?', [subjectId]);
  if (subject.length === 0) return next(new AppError('Subject not found', 404));

  // Check if current user has edit access (to manage members)
  const canEdit = await hasSubjectEditAccess(subjectId, userId, role);

  // === IN-ACCESS: Users with access (grouped by department) ===
  const [inAccessRaw] = await pool.execute(`
    SELECT 
      u.user_id, u.full_name, u.email, u.role,
      d.dept_id, d.dept_name,
      sai.access_role
    FROM subject_access_ids sai
    JOIN users u ON sai.user_id = u.user_id
    JOIN staff st ON u.user_id = st.staff_id
    LEFT JOIN departments d ON st.dept_id = d.dept_id
    WHERE sai.subject_id = ?
    ORDER BY d.dept_name, u.role DESC, u.full_name
  `, [subjectId]);

  // Group by department
  const inAccess = {};
  inAccessRaw.forEach(row => {
    const dept = row.dept_name || 'No Department';
    if (!inAccess[dept]) {
      inAccess[dept] = { dept_id: row.dept_id, members: [] };
    }
    inAccess[dept].members.push({
      user_id: row.user_id,
      full_name: row.full_name,
      email: row.email,
      role: row.role,
      access_role: row.access_role,
      canRemove: canEdit && !(
        (role === 'Staff' && row.role === 'Dept Head') ||
        (role === 'Dept Head' && row.role === 'Dept Head' && row.user_id !== userId) ||
        row.role === 'Admin'
      )
    });
  });

  // === OUT-ACCESS: Eligible users without access (Staff + Dept Heads only) ===
  const [outAccessRaw] = await pool.execute(`
    SELECT 
      u.user_id, u.full_name, u.email, u.role,
      d.dept_id, d.dept_name
    FROM users u
    JOIN staff st ON u.user_id = st.staff_id
    JOIN departments d ON st.dept_id = d.dept_id
    WHERE u.role IN ('Staff', 'Dept Head')
      AND u.user_id NOT IN (
        SELECT user_id FROM subject_access_ids WHERE subject_id = ?
      )
    ORDER BY d.dept_name, u.role DESC, u.full_name
  `, [subjectId]);

  const outAccess = {};
  outAccessRaw.forEach(row => {
    const dept = row.dept_name;
    if (!outAccess[dept]) outAccess[dept] = { dept_id: row.dept_id, members: [] };
    outAccess[dept].members.push({
      user_id: row.user_id,
      full_name: row.full_name,
      email: row.email,
      role: row.role,
      canAdd: canEdit
    });
  });

  res.status(200).json({
    status: 'success',
    data: {
      subject_name: subject[0].subject_name,
      canEdit,
      inAccess: Object.values(inAccess),
      outAccess: Object.values(outAccess),
      canLeave: canEdit && role !== 'Admin'
    }
  });
});

// POST /api/v1/subjects/:subjectId/members → Add Staff / Dept Head
export const addSubjectMember = catchAsync(async (req, res, next) => {
  const { subjectId } = req.params;
  const { userId: targetId } = req.body; // the person being added
  const actorId = req.user.userId;
  const actorRole = req.user.role;

  if (!targetId) return next(new AppError('userId is required', 400));

  // 1. Actor must have edit access
  const hasEdit = await hasSubjectEditAccess(subjectId, actorId, actorRole);
  if (!hasEdit) return next(new AppError('You do not have permission to add members', 403));

  // 2. Target must be Staff or Dept Head
  const [targetRows] = await pool.execute(
    `SELECT role, user_id FROM users WHERE user_id = ? AND role IN ('Staff', 'Dept Head')`,
    [targetId]
  );
  if (targetRows.length === 0) return next(new AppError('User not found or not eligible', 404));
  const targetRole = targetRows[0].role;

  const conn = await pool.getConnection();
  await conn.beginTransaction();

  try {
    // 3. Get target's dept
    const [staff] = await conn.execute(`SELECT dept_id FROM staff WHERE staff_id = ?`, [targetId]);
    if (!staff[0]?.dept_id) throw new AppError('Target user has no department', 400);
    const deptId = staff[0].dept_id;

    // 4. Add dept to subject_access_dept (only once)
    await conn.execute(
      `INSERT IGNORE INTO subject_access_dept (subject_id, dept_id) VALUES (?, ?)`,
      [subjectId, deptId]
    );

    // 5. Add target to subject_access_ids
    const accessRole = targetRole === 'Dept Head' ? 'DeptHead' : 'StaffHandler';
    await conn.execute(
      `INSERT IGNORE INTO subject_access_ids (subject_id, user_id, access_role) VALUES (?, ?, ?)`,
      [subjectId, targetId, accessRole]
    );

    // 6. If target is Dept Head → also ensure all his staff can see (optional logic)
    // Not needed — they get access via subject_access_dept

    await conn.commit();

    res.status(200).json({
      status: 'success',
      message: `${targetRole === 'Dept Head' ? 'Dept Head' : 'Staff'} added successfully`
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// DELETE /api/v1/subjects/:subjectId/members/:targetId → Remove member
export const removeSubjectMember = catchAsync(async (req, res, next) => {
  const { subjectId, targetId } = req.params;
  const actorId = req.user.userId;
  const actorRole = req.user.role;

  // 1. Actor must have edit access
  const hasEdit = await hasSubjectEditAccess(subjectId, actorId, actorRole);
  if (!hasEdit) return next(new AppError('You do not have permission', 403));

  // 2. Get target info
  const [target] = await pool.execute(
    `SELECT role FROM users WHERE user_id = ? AND role IN ('Staff', 'Dept Head')`,
    [targetId]
  );
  if (target.length === 0) return next(new AppError('Member not found', 404));
  const targetRole = target[0].role;

  // 3. HIERARCHY RULES
  if (actorRole === 'Staff' && targetRole === 'Dept Head') {
    return next(new AppError('Staff cannot remove Dept Head', 403));
  }
  if (actorRole === 'Dept Head' && targetRole === 'Dept Head' && targetId !== actorId) {
    return next(new AppError('Dept Head cannot remove another Dept Head', 403));
  }

  const conn = await pool.getConnection();
  await conn.beginTransaction();

  try {
    if (targetRole === 'Dept Head') {
      // Remove Dept Head + clean dept access if no one left from that dept
      await conn.execute(
        `DELETE FROM subject_access_ids WHERE subject_id = ? AND user_id = ?`,
        [subjectId, targetId]
      );

      // Check if any other staff from same dept still has access
      const [remaining] = await conn.execute(`
        SELECT 1 FROM subject_access_ids sai
        JOIN staff st ON sai.user_id = st.staff_id
        WHERE sai.subject_id = ? AND st.dept_id = (
          SELECT dept_id FROM staff WHERE staff_id = ?
        )
      `, [subjectId, targetId]);

      if (remaining.length === 0) {
        await conn.execute(
          `DELETE FROM subject_access_dept WHERE subject_id = ? AND dept_id = (
            SELECT dept_id FROM staff WHERE staff_id = ?
          )`, [subjectId, targetId]
        );
      }
    } else {
      // Just remove staff
      await conn.execute(
        `DELETE FROM subject_access_ids WHERE subject_id = ? AND user_id = ?`,
        [subjectId, targetId]
      );
    }

    await conn.commit();

    res.status(200).json({
      status: 'success',
      message: 'Member removed successfully'
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// POST /api/v1/subjects/:subjectId/leave → Leave subject (Staff / Dept Head only)
export const leaveSubject = catchAsync(async (req, res, next) => {
  const { subjectId } = req.params;
  const userId = req.user.userId;
  const role = req.user.role;

  if (role === 'Admin') return next(new AppError('Admins cannot leave subjects', 403));
  if (role === 'Student') return next(new AppError('Not applicable', 403));

  // Call remove logic (same as remove, but self)
  req.params.targetId = userId;
  await removeSubjectMember(req, res, next);
});