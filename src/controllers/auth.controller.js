import pool from '../config/database.config.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { Resend } from 'resend';
import { invalidateSessionCache } from '../middleware/auth.middleware.js';

dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * NEW ENDPOINT: Check email availability and get organization list
 * Used by all 3 flows: login, forgot-password, account-activation
 * 
 * Query Params:
 *   - email: string (required)
 *   - role: 'teacher' | 'student' | 'admin' (required)
 * 
 * Response:
 *   {
 *     found: boolean,
 *     count: number,
 *     organizations: [
 *       { id: number, name: string, slug: string }
 *     ]
 *   }
 */
export const checkEmail = async (req, res) => {
  const { email, role } = req.query;

  try {
    if (!email || !role) {
      return res.status(400).json({ message: 'Email and role are required' });
    }

    const validRoles = ['teacher', 'student', 'admin'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ message: 'Invalid role. Must be teacher, student, or admin' });
    }

    let accounts = [];

    if (role === 'student') {
      // Check students table
      const { rows: students } = await pool.query(
        'SELECT s.organization_id FROM students s WHERE s.email = $1',
        [email]
      );
      accounts = students;
    } else {
      // Check users table for teacher or admin
      const { rows: users } = await pool.query(
        'SELECT u.organization_id FROM users u WHERE u.email = $1 AND u.role = $2',
        [email, role]
      );
      accounts = users;
    }

    if (accounts.length === 0) {
      return res.json({
        found: false,
        count: 0,
        organizations: []
      });
    }

    // Get unique org IDs and fetch org details
    const uniqueOrgIds = [...new Set(accounts.map(a => a.organization_id))];
    const { rows: orgs } = await pool.query(
      'SELECT id, name, slug FROM organizations WHERE id = ANY($1)',
      [uniqueOrgIds]
    );

    res.json({
      found: true,
      count: orgs.length,
      organizations: orgs.map(o => ({ id: o.id, name: o.name, slug: o.slug }))
    });
  } catch (err) {
    console.error('[AUTH] Check email error:', err.message);
    res.status(500).json({ message: 'An unexpected error occurred.' });
  }
};

export const signup = async (req, res) => {
  const { name, email, password, role, organization_id } = req.body;
  try {
    const hashedPassword = password ? await bcrypt.hash(password, 10) : null;
    const result = await pool.query(
      'INSERT INTO users (name, email, password, role, organization_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [name, email, hashedPassword, role || 'teacher', organization_id]
    );
    res.status(201).json({
      message: 'Account created in pending state',
      userId: result.rows[0].id
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const claimInit = async (req, res) => {
  const { email, organization_id, role } = req.body; 
  try {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 10 * 60 * 1000);

    const { rows: users } = await pool.query(
      role && role !== 'student'
        ? 'SELECT * FROM users WHERE email = $1 AND organization_id = $2 AND role = $3'
        : 'SELECT * FROM users WHERE email = $1 AND organization_id = $2',
      role && role !== 'student' ? [email, organization_id, role] : [email, organization_id]
    );
    const { rows: students } = role === 'teacher' || role === 'admin'
      ? { rows: [] }
      : await pool.query('SELECT * FROM students WHERE email = $1 AND organization_id = $2', [email, organization_id]);

    const target = users[0] || students[0];
    if (!target) return res.status(404).json({ message: 'Email not recognized.' });

    if (users[0]) {
      await pool.query("UPDATE users SET otp_code = $1, otp_expiry = $2 WHERE id = $3", [otp, expiry, target.id]);
    } else {
      await pool.query("UPDATE students SET otp_code = $1, otp_expiry = $2 WHERE id = $3", [otp, expiry, target.id]);
    }

    // Send Real Email if API Key exists
    if (process.env.RESEND_API_KEY) {
      await resend.emails.send({
        from: 'Merge OTP <otp@mahammadanish.me>',
        to: email,
        subject: 'Merge - Your Verification Code',
        html: `<div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px; max-width: 500px; margin: 0 auto;">
          <div style="text-align: center; margin-bottom: 20px;">
            <img src="https://res.cloudinary.com/dmi7vzu8w/image/upload/v1778328482/Picsart_26-05-07_07-29-20-114_v3en0e.jpg" alt="Merge" style="width: 120px; border-radius: 10px;" />
          </div>
          <h2 style="color: #105934; text-align: center;">Merge Verification</h2>
          <p>Hello,</p>
          <p>Your verification code for Merge is:</p>
          <div style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #105934; margin: 20px 0; text-align: center; background: #f0fdf4; padding: 10px; border-radius: 8px;">${otp}</div>
          <p>This code will expire in 10 minutes.</p>
          <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
          <p style="font-size: 12px; color: #666; text-align: center;">If you didn't request this, you can safely ignore this email.</p>
        </div>`
      });
    }

    console.log(`[AUTH] OTP for ${email}: ${otp}`);
    res.json({ message: 'OTP sent successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const claimVerify = async (req, res) => {
  const { email, otp, organization_id, role } = req.body;
  try {
    if (!email || !otp) {
      return res.status(400).json({ message: 'Email and OTP are required' });
    }

    let target = null;

    if (role === 'student' || !role) {
      const query = organization_id
        ? 'SELECT * FROM students WHERE email = $1 AND otp_code = $2 AND otp_expiry > NOW() AND organization_id = $3'
        : 'SELECT * FROM students WHERE email = $1 AND otp_code = $2 AND otp_expiry > NOW()';
      const params = organization_id ? [email, otp, organization_id] : [email, otp];
      const { rows: students } = await pool.query(query, params);
      if (students.length > 0) target = students[0];
    }

    if (!target && (role === 'teacher' || role === 'admin' || !role)) {
      const query = role
        ? (organization_id
          ? 'SELECT * FROM users WHERE email = $1 AND otp_code = $2 AND otp_expiry > NOW() AND organization_id = $3 AND role = $4'
          : 'SELECT * FROM users WHERE email = $1 AND otp_code = $2 AND otp_expiry > NOW() AND role = $3')
        : (organization_id
          ? 'SELECT * FROM users WHERE email = $1 AND otp_code = $2 AND otp_expiry > NOW() AND organization_id = $3'
          : 'SELECT * FROM users WHERE email = $1 AND otp_code = $2 AND otp_expiry > NOW()');
      const params = role
        ? (organization_id ? [email, otp, organization_id, role] : [email, otp, role])
        : (organization_id ? [email, otp, organization_id] : [email, otp]);
      const { rows: users } = await pool.query(query, params);
      if (users.length > 0) target = users[0];
    }

    if (!target) {
      return res.status(400).json({ message: 'Invalid OTP or OTP has expired' });
    }

    res.json({ message: 'OTP verified' });
  } catch (err) {
    console.error('[AUTH] Claim verify error:', err.message);
    res.status(500).json({ message: err.message });
  }
};

export const claimFinalize = async (req, res) => {
  const { email, password, organization_id, role } = req.body;
  try {
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    let updated = false;

    if (role === 'student' || !role) {
      const query = organization_id
        ? 'UPDATE students SET password = $1, is_active = true, otp_code = NULL WHERE email = $2 AND organization_id = $3'
        : 'UPDATE students SET password = $1, is_active = true, otp_code = NULL WHERE email = $2';
      const params = organization_id ? [hashedPassword, email, organization_id] : [hashedPassword, email];
      const result = await pool.query(query, params);
      if (result.rowCount > 0) updated = true;
    }

    if (!updated && (role === 'teacher' || role === 'admin' || !role)) {
      const query = role
        ? (organization_id
          ? 'UPDATE users SET password = $1, is_active = true, otp_code = NULL WHERE email = $2 AND organization_id = $3 AND role = $4'
          : 'UPDATE users SET password = $1, is_active = true, otp_code = NULL WHERE email = $2 AND role = $3')
        : (organization_id
          ? 'UPDATE users SET password = $1, is_active = true, otp_code = NULL WHERE email = $2 AND organization_id = $3'
          : 'UPDATE users SET password = $1, is_active = true, otp_code = NULL WHERE email = $2');
      const params = role
        ? (organization_id ? [hashedPassword, email, organization_id, role] : [hashedPassword, email, role])
        : (organization_id ? [hashedPassword, email, organization_id] : [hashedPassword, email]);
      const result = await pool.query(query, params);
      if (result.rowCount > 0) updated = true;
    }

    if (!updated) {
      return res.status(404).json({ message: 'No matching account was found for the selected organization and role.' });
    }

    res.json({ message: "Account activated successfully!" });
  } catch (err) {
    console.error('[AUTH] Claim finalize error:', err.message);
    res.status(500).json({ message: err.message });
  }
};

export const adminSignupInit = async (req, res) => {
  const { name, email, orgName, orgSlug } = req.body;
  try {
    const slug = orgSlug.toLowerCase().replace(/ /g, '-');
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 10 * 60 * 1000);
    const orgRes = await pool.query('INSERT INTO organizations (name, slug, status) VALUES ($1, $2, $3) RETURNING id', [orgName, slug, 'pending']);
    await pool.query('INSERT INTO users (name, email, organization_id, role, is_active, otp_code, otp_expiry) VALUES ($1, $2, $3, $4, $5, $6, $7)', [name, email, orgRes.rows[0].id, 'admin', false, otp, expiry]);
    
    // Send Real Email if API Key exists
    if (process.env.RESEND_API_KEY) {
      await resend.emails.send({
        from: 'Merge OTP <otp@mahammadanish.me>',
        to: email,
        subject: 'Welcome to Merge - Verify Your College',
        html: `<div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px; max-width: 500px; margin: 0 auto;">
          <div style="text-align: center; margin-bottom: 20px;">
            <img src="https://res.cloudinary.com/dmi7vzu8w/image/upload/v1778328482/Picsart_26-05-07_07-29-20-114_v3en0e.jpg" alt="Merge" style="width: 120px; border-radius: 10px;" />
          </div>
          <h2 style="color: #105934; text-align: center;">Welcome to Merge!</h2>
          <p>Thank you for registering <strong>${orgName}</strong>.</p>
          <p>To complete your college registration, please use the following verification code:</p>
          <div style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #105934; margin: 20px 0; text-align: center; background: #f0fdf4; padding: 10px; border-radius: 8px;">${otp}</div>
          <p>This code will expire in 10 minutes.</p>
          <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
          <p style="font-size: 12px; color: #666; text-align: center;">Connecting institutions to the future.</p>
        </div>`
      });
    }

    console.log(`[AUTH] Admin OTP: ${otp}`);
    res.json({ message: 'OTP sent' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const adminSignupVerify = async (req, res) => {
  const { email, otp } = req.body;
  try {
    const { rows } = await pool.query(
      'SELECT u.*, o.name as organization_name, o.slug as organization_slug FROM users u LEFT JOIN organizations o ON u.organization_id = o.id WHERE u.email = $1 AND u.otp_code = $2 AND u.role = $3',
      [email, otp, 'admin']
    );
    if (rows.length === 0) return res.status(400).json({ message: 'Invalid OTP' });
    await pool.query("UPDATE organizations SET status = 'active' WHERE id = $1", [rows[0].organization_id]);
    
    const token = jwt.sign(
      { id: rows[0].id, email: rows[0].email, role: 'admin', organization_id: rows[0].organization_id }, 
      process.env.JWT_SECRET || 'secret'
    );
    
    res.json({ 
      message: 'Verified', 
      token, 
      user: { 
        id: rows[0].id, 
        name: rows[0].name, 
        role: 'admin',
        organization: rows[0].organization_name,
        organization_id: rows[0].organization_id,
        organization_slug: rows[0].organization_slug
      } 
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const login = async (req, res) => {
  const { email, password, role, organization_id } = req.body;
  try {
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const userRole = role || 'teacher';
    let accounts = [];

    if (userRole === 'student') {
      // Check students table
      const { rows: students } = await pool.query(
        'SELECT s.*, o.name as organization_name, o.slug as organization_slug FROM students s LEFT JOIN organizations o ON s.organization_id = o.id WHERE s.email = $1',
        [email]
      );
      accounts = students;
    } else {
      // Check users table for teacher or admin
      const { rows: users } = await pool.query(
        'SELECT u.*, o.name as organization_name, o.slug as organization_slug FROM users u LEFT JOIN organizations o ON u.organization_id = o.id WHERE u.email = $1 AND u.role = $2',
        [email, userRole]
      );
      accounts = users;
    }

    if (accounts.length === 0) {
      return res.status(401).json({ message: 'No account found with this institutional email.' });
    }

    // Filter by password
    const validAccounts = [];
    for (const account of accounts) {
      const isMatch = await bcrypt.compare(password, account.password);
      if (isMatch) validAccounts.push(account);
    }

    if (validAccounts.length === 0) {
      return res.status(401).json({ message: 'The password you entered is incorrect. Please try again.' });
    }

    // If multiple organizations found and no organization_id provided, ask user to select
    if (validAccounts.length > 1 && !organization_id) {
      const orgs = validAccounts.map(a => ({
        id: a.organization_id,
        name: a.organization_name,
        slug: a.organization_slug
      }));
      return res.json({ status: 'select_organization', organizations: orgs });
    }

    // Select the target account
    let targetAccount = null;
    if (organization_id) {
      targetAccount = validAccounts.find(a => a.organization_id === parseInt(organization_id));
      if (!targetAccount) {
        return res.status(401).json({ message: 'Account not found for the selected organization.' });
      }
    } else {
      targetAccount = validAccounts[0];
    }

    // Generate JWT token
    const token = jwt.sign(
      {
        id: targetAccount.id,
        email: targetAccount.email,
        role: userRole,
        organization_id: targetAccount.organization_id
      },
      process.env.JWT_SECRET || 'secret'
    );

    res.json({
      token,
      user: {
        id: targetAccount.id,
        name: targetAccount.name,
        email: targetAccount.email,
        role: userRole,
        college_id: targetAccount.college_id,
        organization: targetAccount.organization_name,
        organization_id: targetAccount.organization_id,
        organization_slug: targetAccount.organization_slug,
        year: targetAccount.year,
        stream: targetAccount.stream,
        image_url: targetAccount.image_url
      }
    });
  } catch (err) {
    console.error('[AUTH] Login error:', err.message);
    res.status(500).json({ message: 'An unexpected error occurred. Please try again later.' });
  }
};

export const adminLogin = async (req, res) => {
  const { email, password, device_id, login_platform } = req.body;
  try {
    const { rows } = await pool.query(
      'SELECT u.*, o.name as organization_name, o.slug as organization_slug FROM users u LEFT JOIN organizations o ON u.organization_id = o.id WHERE u.email = $1 AND u.role = $2',
      [email, 'admin']
    );
    if (rows.length === 0) return res.status(401).json({ message: 'Invalid Admin credentials.' });
    const isMatch = await bcrypt.compare(password, rows[0].password);
    if (!isMatch) return res.status(401).json({ message: 'Invalid Admin credentials.' });

    // ── Single Active Session Enforcement (Refinement #4, #8) ──
    // Generate a unique session token — any previous session is implicitly invalidated
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const deviceId = device_id || req.headers['user-agent']?.substring(0, 200) || 'unknown';
    const platform = login_platform || 'desktop';

    // Store session metadata in DB (overwrites old session = forces logout on old device)
    await pool.query(
      `UPDATE users SET 
        admin_session_token = $1, 
        admin_device_id = $2, 
        admin_login_platform = $3, 
        admin_last_seen = NOW(), 
        admin_login_timestamp = NOW() 
      WHERE id = $4`,
      [sessionToken, deviceId, platform, rows[0].id]
    );

    // Invalidate any stale in-memory cached session
    invalidateSessionCache(rows[0].id);

    // Include session_token in JWT so middleware can verify active session
    const token = jwt.sign(
      { 
        id: rows[0].id, 
        email: rows[0].email, 
        role: 'admin', 
        organization_id: rows[0].organization_id,
        session_token: sessionToken 
      }, 
      process.env.JWT_SECRET || 'secret'
    );
    
    console.log(`[AUTH] Admin login: ${email} from ${platform} (device: ${deviceId.substring(0, 50)}...)`);

    res.json({ 
      token, 
      user: { 
        id: rows[0].id, 
        name: rows[0].name, 
        email: rows[0].email,
        role: 'admin',
        college_id: rows[0].college_id || 'ADMIN-1',
        organization: rows[0].organization_name || 'Merge Institute of Technology',
        organization_id: rows[0].organization_id,
        organization_slug: rows[0].organization_slug,
        image_url: rows[0].image_url 
      } 
    });
  } catch (err) {
    console.error('[AUTH] Admin login error:', err.message);
    res.status(500).json({ message: 'Internal server error.' });
  }
};

export const studentLogin = async (req, res) => {
  const { email, password, organization_id } = req.body;
  try {
    const { rows } = await pool.query(
      'SELECT s.*, o.name as organization_name, o.slug as organization_slug FROM students s LEFT JOIN organizations o ON s.organization_id = o.id WHERE s.email = $1',
      [email]
    );
    if (rows.length === 0) return res.status(401).json({ message: 'No student record found for this institutional email.' });
    
    // Filter matching accounts by password
    const validUsers = [];
    for (const user of rows) {
      const isMatch = await bcrypt.compare(password, user.password);
      if (isMatch) validUsers.push(user);
    }
    
    if (validUsers.length === 0) return res.status(401).json({ message: 'Incorrect password. Please verify and try again.' });
    
    let targetUser = null;
    if (organization_id) {
      targetUser = validUsers.find(u => u.organization_id === parseInt(organization_id));
      if (!targetUser) return res.status(401).json({ message: 'Account not found for the selected organization.' });
    } else {
      if (validUsers.length > 1) {
        const orgs = validUsers.map(u => ({ id: u.organization_id, name: u.organization_name, slug: u.organization_slug }));
        return res.json({ status: 'select_organization', organizations: orgs });
      }
      targetUser = validUsers[0];
    }
    
    const token = jwt.sign({ id: targetUser.id, role: 'student', organization_id: targetUser.organization_id }, process.env.JWT_SECRET || 'secret');
    res.json({ 
      token, 
      user: { 
        id: targetUser.id, 
        name: targetUser.name, 
        email: targetUser.email,
        role: 'student', 
        college_id: targetUser.college_id,
        organization: targetUser.organization_name,
        organization_id: targetUser.organization_id,
        organization_slug: targetUser.organization_slug,
        year: targetUser.year,
        stream: targetUser.stream,
        image_url: targetUser.image_url
      } 
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error during login.' });
  }
};

export const forgotPasswordInit = async (req, res) => {
  const { email, organization_id, role } = req.body;
  try {
    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 10 * 60 * 1000);

    let target = null;
    let targetTable = null;

    if (role === 'student' || !role) {
      // Check students table first
      const query = organization_id 
        ? 'SELECT * FROM students WHERE email = $1 AND organization_id = $2'
        : 'SELECT * FROM students WHERE email = $1';
      const params = organization_id ? [email, organization_id] : [email];
      const { rows: students } = await pool.query(query, params);
      if (students.length > 0) {
        target = students[0];
        targetTable = 'students';
      }
    }

    if (!target && (role === 'teacher' || role === 'admin' || !role)) {
      // Check users table
      const query = organization_id
        ? 'SELECT * FROM users WHERE email = $1 AND organization_id = $2 AND role = $3'
        : 'SELECT * FROM users WHERE email = $1 AND role = $2';
      const params = organization_id
        ? [email, organization_id, role || 'teacher']
        : [email, role || 'teacher'];
      const { rows: users } = await pool.query(query, params);
      if (users.length > 0) {
        target = users[0];
        targetTable = 'users';
      }
    }

    if (!target) {
      return res.status(404).json({ message: 'Email not found.' });
    }

    // Update OTP in the appropriate table
    if (targetTable === 'users') {
      await pool.query("UPDATE users SET otp_code = $1, otp_expiry = $2 WHERE id = $3", [otp, expiry, target.id]);
    } else {
      await pool.query("UPDATE students SET otp_code = $1, otp_expiry = $2 WHERE id = $3", [otp, expiry, target.id]);
    }

    // Send Real Email if API Key exists
    if (process.env.RESEND_API_KEY) {
      await resend.emails.send({
        from: 'Merge OTP <otp@mahammadanish.me>',
        to: email,
        subject: 'Merge - Reset Your Password',
        html: `<div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px; max-width: 500px; margin: 0 auto;">
          <h2 style="color: #105934; text-align: center;">Password Reset</h2>
          <p>You requested to reset your password. Use the following code:</p>
          <div style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #105934; margin: 20px 0; text-align: center; background: #f0fdf4; padding: 10px; border-radius: 8px;">${otp}</div>
          <p>This code will expire in 10 minutes.</p>
        </div>`
      });
    }

    console.log(`[AUTH] Forgot Password OTP for ${email} in org ${organization_id || 'any'}: ${otp}`);
    res.json({ message: 'OTP sent successfully' });
  } catch (err) {
    console.error('[AUTH] Forgot password init error:', err.message);
    res.status(500).json({ message: err.message });
  }
};

export const forgotPasswordVerify = async (req, res) => {
  const { email, otp, organization_id, role } = req.body;
  try {
    if (!email || !otp) {
      return res.status(400).json({ message: 'Email and OTP are required' });
    }

    let target = null;
    let targetTable = null;

    if (role === 'student' || !role) {
      const query = organization_id
        ? 'SELECT * FROM students WHERE email = $1 AND otp_code = $2 AND otp_expiry > NOW() AND organization_id = $3'
        : 'SELECT * FROM students WHERE email = $1 AND otp_code = $2 AND otp_expiry > NOW()';
      const params = organization_id ? [email, otp, organization_id] : [email, otp];
      const { rows: students } = await pool.query(query, params);
      if (students.length > 0) {
        target = students[0];
        targetTable = 'students';
      }
    }

    if (!target && (role === 'teacher' || role === 'admin' || !role)) {
      const query = organization_id
        ? 'SELECT * FROM users WHERE email = $1 AND otp_code = $2 AND otp_expiry > NOW() AND organization_id = $3 AND role = $4'
        : 'SELECT * FROM users WHERE email = $1 AND otp_code = $2 AND otp_expiry > NOW() AND role = $3';
      const params = organization_id
        ? [email, otp, organization_id, role || 'teacher']
        : [email, otp, role || 'teacher'];
      const { rows: users } = await pool.query(query, params);
      if (users.length > 0) {
        target = users[0];
        targetTable = 'users';
      }
    }

    if (!target) {
      return res.status(400).json({ message: 'Invalid OTP or OTP has expired' });
    }

    res.json({ message: 'OTP verified' });
  } catch (err) {
    console.error('[AUTH] Forgot password verify error:', err.message);
    res.status(500).json({ message: err.message });
  }
};

export const forgotPasswordFinalize = async (req, res) => {
  const { email, password, organization_id, role } = req.body;
  try {
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    let updated = false;

    if (role === 'student' || !role) {
      const query = organization_id
        ? 'UPDATE students SET password = $1, otp_code = NULL WHERE email = $2 AND organization_id = $3'
        : 'UPDATE students SET password = $1, otp_code = NULL WHERE email = $2';
      const params = organization_id ? [hashedPassword, email, organization_id] : [hashedPassword, email];
      const result = await pool.query(query, params);
      if (result.rowCount > 0) updated = true;
    }

    if (!updated && (role === 'teacher' || role === 'admin' || !role)) {
      const query = organization_id
        ? 'UPDATE users SET password = $1, otp_code = NULL WHERE email = $2 AND organization_id = $3 AND role = $4'
        : 'UPDATE users SET password = $1, otp_code = NULL WHERE email = $2 AND role = $3';
      const params = organization_id
        ? [hashedPassword, email, organization_id, role || 'teacher']
        : [hashedPassword, email, role || 'teacher'];
      await pool.query(query, params);
    }

    res.json({ message: "Password updated successfully!" });
  } catch (err) {
    console.error('[AUTH] Forgot password finalize error:', err.message);
    res.status(500).json({ message: err.message });
  }
};
