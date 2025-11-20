// src/controllers/userController.js
import { pool } from '../config/database.js';
import {catchAsync} from '../utils/catchAsync.js';
import AppError from '../utils/AppError.js';

export const getMyDashboard = catchAsync(async (req, res, next) => {
  const userId = req.user.userId;
  const role = req.user.role;

  let query = '';
  let values = [userId];

  if (role === 'Student') {
    query = `
      SELECT u.full_name, u.email, u.profile_image_url, u.last_login,
             COALESCE(s.practice_score, 0) as practice_score,
             COALESCE(s.test_score, 0) as test_score,
             COALESCE(s.levels_completed, 0) as levels_completed,
             COALESCE(s.topics_completed, 0) as topics_completed,
             COALESCE(s.subjects_completed, 0) as subjects_completed
      FROM users u
      LEFT JOIN students s ON u.user_id = s.student_id
      WHERE u.user_id = ?
    `;
  } 
  else if (role === 'Staff' || role === 'Dept Head') {
    query = `
      SELECT u.full_name, u.email, u.profile_image_url, u.last_login, u.role,
             st.designation, st.is_tutor, d.dept_name
      FROM users u
      LEFT JOIN staff st ON u.user_id = st.staff_id
      LEFT JOIN departments d ON st.dept_id = d.dept_id
      WHERE u.user_id = ?
    `;
  } 
  else if (role === 'Admin') {
    query = `
      SELECT full_name, email, profile_image_url, last_login,
             'System Administrator' as designation
      FROM users 
      WHERE user_id = ? AND role = 'Admin'
    `;
  }

  const [rows] = await pool.execute(query, values);
  if (!rows[0]) return next(new AppError('User not found', 404));

  const data = rows[0];

  const response = {
    full_name: data.full_name,
    email: data.email,
    role: role,
    profile_image_url: data.profile_image_url || null,
    last_login: data.last_login,
    dashboard: {}
  };

  if (role === 'Student') {
    response.dashboard = {
      practice_score: Number(data.practice_score),
      test_score: Number(data.test_score),
      levels_completed: Number(data.levels_completed),
      topics_completed: Number(data.topics_completed),
      subjects_completed: Number(data.subjects_completed)
    };
  } else if (role === 'Staff' || role === 'Dept Head') {
    response.dashboard = {
      designation: data.designation || 'Staff Member',
      department: data.dept_name || 'Not Assigned',
      is_tutor: Boolean(data.is_tutor)
    };
  } else if (role === 'Admin') {
    response.dashboard = { designation: data.designation };
  }

  res.status(200).json({
    status: 'success',
    data: response
  });
});

export const getMyProfile = catchAsync(async (req, res, next) => {
  const userId = req.user.userId;
  const role = req.user.role;

  let query = '';
  let values = [userId];

  if (role === 'Student') {
    query = `
      SELECT u.*, s.batch_year, s.practice_score, s.test_score,
             s.levels_completed, s.topics_completed, s.subjects_completed,
             d.dept_name, tutor.full_name as tutor_name
      FROM users u
      LEFT JOIN students s ON u.user_id = s.student_id
      LEFT JOIN departments d ON s.dept_id = d.dept_id
      LEFT JOIN users tutor ON s.tutor_id = tutor.user_id
      WHERE u.user_id = ?
    `;
  } else if (role === 'Staff' || role === 'Dept Head') {
    query = `
      SELECT u.*, st.designation, st.is_tutor, d.dept_name
      FROM users u
      LEFT JOIN staff st ON u.user_id = st.staff_id
      LEFT JOIN departments d ON st.dept_id = d.dept_id
      WHERE u.user_id = ?
    `;
  } else if (role === 'Admin') {
    query = `
      SELECT *, 'System Administrator' as designation 
      FROM users WHERE user_id = ? AND role = 'Admin'
    `;
  }

  const [rows] = await pool.execute(query, values);
  if (!rows[0]) return next(new AppError('Profile not found', 404));

  const u = rows[0];

  const profile = {
    user_id: u.user_id,
    full_name: u.full_name,
    email: u.email,
    phone_number: u.phone_number || null,
    profile_image_url: u.profile_image_url || null,
    role: u.role,
    last_login: u.last_login,
    joined_at: u.created_at
  };

  if (role === 'Student') {
    Object.assign(profile, {
      batch_year: u.batch_year,
      department: u.dept_name || 'Not Assigned',
      practice_score: Number(u.practice_score || 0),
      test_score: Number(u.test_score || 0),
      levels_completed: Number(u.levels_completed || 0),
      topics_completed: Number(u.topics_completed || 0),
      subjects_completed: Number(u.subjects_completed || 0),
      tutor: u.tutor_name ? { name: u.tutor_name } : null
    });
  } else if (role === 'Staff' || role === 'Dept Head') {
    Object.assign(profile, {
      designation: u.designation || 'N/A',
      department: u.dept_name || 'Not Assigned',
      is_tutor: Boolean(u.is_tutor)
    });
  } else if (role === 'Admin') {
    profile.designation = u.designation;
  }

  res.status(200).json({
    status: 'success',
    data: profile
  });
});