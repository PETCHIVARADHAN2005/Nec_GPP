// src/utils/sendEmail.js
import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

export const sendOTPEmail = async (to, fullName, otp) => {
  const html = `
    <div style="font-family: Arial; padding: 30px; background: #f9f9f9; border-radius: 10px;">
      <h2 style="color: #d32f2f;">NEC GATE Portal</h2>
      <p>Hello <strong>${fullName}</strong>,</p>
      <p>Your password reset OTP is:</p>
      <h1 style="background:#000; color:#fff; padding:15px; letter-spacing:8px; display:inline-block;">
        ${otp}
      </h1>
      <p><strong>Valid for 10 minutes only</strong></p>
      <p>If you didn't request this, ignore.</p>
      <hr>
      <small>NEC GATE Preparation Portal © 2025</small>
    </div>
  `;

  await transporter.sendMail({
    from: `"NEC GATE Portal" <${process.env.EMAIL_USER}>`,
    to,
    subject: 'Password Reset OTP - Valid 10 Minutes',
    html
  });
};